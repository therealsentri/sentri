import 'dart:async';

import '../../core/net/api.dart';

/// v55: entitlement mirror. The server is the source of truth; this decides
/// which screen opens. ChangeNotifier so the UI rebuilds the moment it changes.
class PremiumState extends ChangeNotifier {
  /// Vic's own build is compiled with -D SENTRI_FREE_BUILD=true.
  static const bool freeBuild = bool.fromEnvironment('SENTRI_FREE_BUILD', defaultValue: false);
  static SentriApi? _api;
  static final PremiumState instance = PremiumState();

  bool premium = freeBuild;
  String plan = 'free';
  String? trialEndsAt;
  DateTime _checkedAt = DateTime.fromMillisecondsSinceEpoch(0);
  Future<void>? _inFlight;

  static void bind(SentriApi api) => _api = api;

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
    } catch (_) {
      // Keep the last known value; retry on the next gate after a minute.
    }
  }

  String get label {
    if (premium && plan == 'free') return '14-day trial';
    if (premium) return 'Premium';
    return 'Free';
  }
}
