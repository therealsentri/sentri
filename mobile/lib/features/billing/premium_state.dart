import 'dart:async';
import 'dart:convert';

import 'package:flutter/foundation.dart';

import '../../core/net/api.dart';
import '../../core/storage/key_value_store.dart';

/// Entitlement mirror. The server is the source of truth; this decides which
/// screen opens. ChangeNotifier so the UI rebuilds the moment it changes.
class PremiumState extends ChangeNotifier {
  /// Vic's own build is compiled with -D SENTRI_FREE_BUILD=true.
  static const bool freeBuild = bool.fromEnvironment('SENTRI_FREE_BUILD', defaultValue: false);
  static SentriApi? _api;
  static KeyValueStore? _store;
  static const _cacheKey = 'premium.cache.v1';
  static final PremiumState instance = PremiumState();

  /// True once the entitlement is known (from the phone's cache or the server).
  /// Until then the UI says "Checking access…", never "Free".
  bool ready = freeBuild;
  bool premium = freeBuild;
  String plan = 'free';
  String? trialEndsAt;
  DateTime _checkedAt = DateTime.fromMillisecondsSinceEpoch(0);
  Future<void>? _inFlight;

  /// Bind the API and restore the last confirmed answer. Await this at startup
  /// so a cache read can never overwrite a fresher server reply.
  static Future<void> bind(SentriApi api, {KeyValueStore? store}) async {
    _api = api;
    _store = store;
    await _load();
  }

  /// A paid user must never appear to lose access just because one status call
  /// failed while the app was starting. The last confirmed answer lives on the phone.
  static Future<void> _load() async {
    try {
      final raw = await _store?.read(_cacheKey);
      if (raw == null) return;
      final decoded = jsonDecode(raw);
      if (decoded is! Map<String, dynamic>) return;
      final m = decoded;
      final at = m['checkedAt'] as int? ?? 0;
      final s = instance;
      // A server answer that arrived while storage was reading is newer: keep it.
      if (at <= s._checkedAt.millisecondsSinceEpoch) {
        if (!s.ready) {
          s.ready = true;
          s.notifyListeners();
        }
        return;
      }
      s.premium = m['premium'] == true || freeBuild;
      s.plan = m['plan'] as String? ?? 'free';
      s.trialEndsAt = m['trialEndsAt'] as String?;
      s._checkedAt = DateTime.fromMillisecondsSinceEpoch(at);
      s.ready = true;
      s.notifyListeners();
    } catch (_) {
      final s = instance;
      if (!s.ready) {
        s.ready = true;
        s.notifyListeners();
      }
    }
  }

  static Future<void> _persist(PremiumState s) async {
    try {
      await _store?.write(_cacheKey, jsonEncode({
        'premium': s.premium, 'plan': s.plan, 'trialEndsAt': s.trialEndsAt,
        'checkedAt': s._checkedAt.millisecondsSinceEpoch,
      }));
    } catch (_) {}
  }

  static Future<void> refresh({bool force = false}) async {
    if (freeBuild || _api == null) return;
    final s = instance;
    if (force) {
      // A purchase just finished: let any earlier check finish, then re-check
      // the server regardless of the 60-second throttle.
      final waiting = s._inFlight;
      if (waiting != null) {
        try { await waiting; } catch (_) {}
      }
    } else {
      if (s._inFlight != null) return s._inFlight!;
      if (DateTime.now().difference(s._checkedAt) < const Duration(seconds: 60)) return;
    }
    final f = _doRefresh(s).whenComplete(() => s._inFlight = null);
    s._inFlight = f;
    return f;
  }

  static Future<void> _doRefresh(PremiumState s) async {
    try {
      final m = await _api!.billingStatus().timeout(const Duration(seconds: 8));
      final premiumValue = m['premium'];
      final planValue = m['plan'];
      // A malformed/proxy answer must never lock a paying user out.
      if (premiumValue is! bool || planValue is! String) {
        if (!s.ready) {
          s.ready = true;
          s.notifyListeners();
        }
        return;
      }
      final nextTrial = m['trialEndsAt'] as String?;
      if (premiumValue != s.premium || planValue != s.plan || nextTrial != s.trialEndsAt) {
        s.premium = premiumValue;
        s.plan = planValue;
        s.trialEndsAt = nextTrial;
        s.notifyListeners();
      }
      s._checkedAt = DateTime.now();
      s.ready = true;
      unawaited(_persist(s));
    } catch (_) {
      // Keep the last known value; retry on the next gate after a minute.
      if (!s.ready) {
        s.ready = true;
        s.notifyListeners();
      }
    }
  }

  String get label {
    if (!ready) return 'Checking access…';
    if (premium && plan == 'free') return '7-day trial';
    if (premium) return 'Premium';
    return 'Free';
  }
}
