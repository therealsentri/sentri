import 'dart:async';

import 'dart:convert';

import 'package:flutter/foundation.dart';

import '../../core/net/api.dart';
import '../../core/storage/key_value_store.dart';

/// v55: entitlement mirror. The server is the source of truth; this decides
/// which screen opens. ChangeNotifier so the UI rebuilds the moment it changes.
class PremiumState extends ChangeNotifier {
  /// Vic's own build is compiled with -D SENTRI_FREE_BUILD=true.
  static const bool freeBuild = bool.fromEnvironment('SENTRI_FREE_BUILD', defaultValue: false);
  static SentriApi? _api;
  static KeyValueStore? _store;
  static const _cacheKey = 'premium.cache.v1';
  static final PremiumState instance = PremiumState();

  /// True once the entitlement is known (from the phone's cache or the server).
  /// Until then the UI must say "checking", never "Free".
  bool ready = freeBuild;

  bool premium = freeBuild;
  String plan = 'free';
  String? trialEndsAt;
  DateTime _checkedAt = DateTime.fromMillisecondsSinceEpoch(0);
  Future<void>? _inFlight;

  static void bind(SentriApi api, {KeyValueStore? store}) {
    _api = api;
    _store = store;
    if (store != null) unawaited(_load());
  }

  /// A paid user must never appear to lose access just because one status call
  /// failed while the app was starting. The last confirmed answer lives on the phone.
  static Future<void> _load() async {
    try {
      final raw = await _store?.read(_cacheKey);
      if (raw == null) return;
      final m = jsonDecode(raw) as Map<String, dynamic>;
      final s = instance;
      s.premium = m['premium'] == true || freeBuild;
      s.plan = m['plan'] as String? ?? 'free';
      s.trialEndsAt = m['trialEndsAt'] as String?;
      final at = m['checkedAt'] as int? ?? 0;
      s._checkedAt = DateTime.fromMillisecondsSinceEpoch(at);
      s.ready = true;
      s.notifyListeners();
    } catch (_) {}
  }

  static Future<void> _persist(PremiumState s) async {
    try {
      await _store?.write(_cacheKey, jsonEncode({
        'premium': s.premium, 'plan': s.plan, 'trialEndsAt': s.trialEndsAt,
        'checkedAt': s._checkedAt.millisecondsSinceEpoch,
      }));
    } catch (_) {}
  }

  static Future<void> refresh() {
    if (freeBuild || _api == null) return Future.value();
    final s = instance;
    // One request at a time, and trust it for at most 60 seconds.
    if (s._inFlight != null) return s._inFlight!;
    if (DateTime.now().difference(s._checkedAt) < const Duration(seconds: 60)) return Future.value();
    s._inFlight = _doRefresh(s).whenComplete(() => s._inFlight = null);
    return s._inFlight!;
  }

  static Future<void> _doRefresh(PremiumState s) async {
    try {
      final m = await _api!.billingStatus();
      final nextPremium = m['premium'] is bool ? m['premium'] as bool : false;
      final nextPlan = m['plan'] as String? ?? 'free';
      final nextTrial = m['trialEndsAt'] as String?;
      if (nextPremium != s.premium || nextPlan != s.plan || nextTrial != s.trialEndsAt) {
        s.premium = nextPremium;
        s.plan = nextPlan;
        s.trialEndsAt = nextTrial;
        s.notifyListeners();
      }
      s._checkedAt = DateTime.now();
      s.ready = true;
      unawaited(_persist(s));
    } catch (_) {
      // Keep the last known value; retry on the next gate after a minute.
      s.ready = true;
    }
  }

  String get label {
    if (premium && plan == 'free') return '14-day trial';
    if (premium) return 'Premium';
    return 'Free';
  }
}
