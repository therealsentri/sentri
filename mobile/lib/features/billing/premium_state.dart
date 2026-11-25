import '../../core/net/api.dart';

/// v53: entitlement mirror only. The server is the source of truth; this just
/// decides which screen to open. It is refreshed on startup and whenever the
/// shortcuts page is opened (including returning from a payment browser).
class PremiumState {
  /// Vic's own build is compiled with -D SENTRI_FREE_BUILD=true: every feature
  /// is open and the payment screen is never a gate for him.
  static const bool freeBuild = bool.fromEnvironment('SENTRI_FREE_BUILD', defaultValue: false);
  static SentriApi? _api;
  static bool premium = false;
  static String plan = 'free';
  static String? trialEndsAt;

  static void bind(SentriApi api) => _api = api;

  static Future<void> refresh() async {
    if (freeBuild) { premium = true; return; }
    final api = _api;
    if (api == null) return;
    try {
      final s = await api.billingStatus();
      premium = s['premium'] is bool ? s['premium'] as bool : false;
      plan = s['plan'] as String? ?? 'free';
      trialEndsAt = s['trialEndsAt'] as String?;
    } catch (_) {
      // Keeping the last known value avoids locking an emergency user out
      // because of a flaky connection.
    }
  }

  static String get label {
    if (premium && plan == 'free') return '14-day trial';
    if (premium) return 'Premium';
    return 'Free';
  }
}
