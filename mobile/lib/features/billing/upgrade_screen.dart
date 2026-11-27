import 'package:flutter/material.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../core/net/api.dart';
import '../../core/widgets/brand.dart';
import 'premium_state.dart';

/// v51: the only place in the app where a purchase starts. The decision about
/// what is unlocked lives on the server (users.plan), never here.
class UpgradeScreen extends StatefulWidget {
  const UpgradeScreen({super.key, required this.api});
  final SentriApi api;

  @override
  State<UpgradeScreen> createState() => _UpgradeScreenState();
}

class _UpgradeScreenState extends State<UpgradeScreen> with WidgetsBindingObserver {
  String _rail = 'paystack';
  String _plan = 'monthly';
  String? _current;
  String? _error;
  bool _busy = false;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    PremiumState.refresh();
    widget.api.billingStatus().then((s) {
      if (mounted) setState(() => _current = s['plan'] as String? ?? 'free');
    }).catchError((_) {});
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed && mounted) {
      PremiumState.refresh();
      widget.api.billingStatus().then((s) {
        if (mounted) setState(() => _current = s['plan'] as String? ?? 'free');
      }).catchError((_) {});
    }
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  static const _plans = [
    ('monthly', 'Monthly', '₦1,200 / \$2.99', 'Everything premium, billed monthly.'),
    ('yearly', 'Yearly', '₦12,000', 'Two months free. One payment for the year.'),
    ('family', 'Family', '₦20,000 / year', 'Up to five people in one household.'),
  ];

  Future<void> _pay() async {
    setState(() { _busy = true; _error = null; });
    try {
      final url = await widget.api.billingCheckout(_rail, _plan);
      if (url.isEmpty) throw const FormatException('No checkout URL returned');
      final uri = Uri.parse(url);
      final ok = await launchUrl(uri, mode: LaunchMode.externalApplication);
      if (!ok && mounted) setState(() => _error = 'Could not open the payment page.');
    } catch (e) {
      if (mounted) setState(() => _error = 'Payment page unavailable. Check your connection and try again.');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final cs = Theme.of(context).colorScheme;
    return Scaffold(
      appBar: AppBar(title: const Text('Sentri Premium')),
      body: ListView(
        padding: const EdgeInsets.fromLTRB(18, 12, 18, 28),
        children: [
          // Playful 3D card — replaces the flat oval.
          SizedBox(
            height: 188,
            child: Stack(
              alignment: Alignment.center,
              children: [
                Positioned(
                  top: 8,
                  child: Container(
                    width: 250, height: 150,
                    decoration: BoxDecoration(
                      borderRadius: BorderRadius.circular(24),
                      gradient: const LinearGradient(colors: [Color(0xFF0E08A3), Color(0xFF4B2FE8)]),
                      boxShadow: [BoxShadow(color: const Color(0xFF0E08A3).withValues(alpha: .35), blurRadius: 28, offset: const Offset(0, 18))],
                    ),
                  ),
                ),
                Positioned(
                  top: 20,
                  child: Transform.rotate(
                    angle: -0.11,
                    child: Container(
                      width: 250, height: 150,
                      decoration: BoxDecoration(
                        borderRadius: BorderRadius.circular(24),
                        gradient: const LinearGradient(
                          begin: Alignment.topLeft, end: Alignment.bottomRight,
                          colors: [Color(0xFF17205C), Color(0xFF0E08A3), Color(0xFF6C4BFF)],
                        ),
                        border: Border.all(color: Colors.white.withValues(alpha: .22)),
                        boxShadow: [BoxShadow(color: Colors.black.withValues(alpha: .28), blurRadius: 22, offset: const Offset(0, 14))],
                      ),
                      child: Stack(
                        children: [
                          Positioned(right: 18, top: 18, child: Icon(Icons.wifi, color: Colors.white.withValues(alpha: .85), size: 22)),
                          const Positioned(left: 22, top: 28, child: SentriMark(size: 26, color: Colors.white)),
                          Positioned(left: 22, bottom: 44, child: Text('SENTRI', style: TextStyle(color: Colors.white.withValues(alpha: .85), fontSize: 13, letterSpacing: 3))),
                          const Positioned(left: 22, bottom: 16, child: Text('••••  ••••  ••••  2026', style: TextStyle(color: Colors.white, fontSize: 15, letterSpacing: 2))),
                          const Positioned(right: 20, bottom: 14, child: Row(children: [
                            CircleAvatar(radius: 13, backgroundColor: Color(0xFFEB001B)),
                            CircleAvatar(radius: 13, backgroundColor: Color(0xFFF79E1B)),
                          ])),
                        ],
                      ),
                    ),
                  ),
                ),
              ],
            ),
          ),
          const SizedBox(height: 8),
          Text('Safety stays free.', style: Theme.of(context).textTheme.headlineSmall),
          const SizedBox(height: 6),
          const Text('Premium unlocks travel, gyms near me, heart camera & health suite, exercise & awards, water reminders, find my phone, 1-year history, unlimited contacts, custom alarms and watch features. Your emergency alarm never moves behind a paywall.'),
          if (_current != null && _current != 'free') ...[
            const SizedBox(height: 14),
            Container(
              padding: const EdgeInsets.all(14),
              decoration: BoxDecoration(
                borderRadius: BorderRadius.circular(14),
                gradient: const LinearGradient(colors: [Color(0xFFEDEBFF), Color(0xFFDDF7E6)]),
              ),
              child: Text('Current plan: $_current', style: const TextStyle(color: Color(0xFF0E08A3))),
            ),
          ],
          const SizedBox(height: 18),
          SegmentedButton<String>(
            segments: const [
              ButtonSegment(value: 'paystack', label: Text('Nigeria · Paystack')),
              ButtonSegment(value: 'creem', label: Text('International · Card')),
            ],
            selected: {_rail},
            onSelectionChanged: (v) => setState(() => _rail = v.first),
          ),
          const SizedBox(height: 16),
          for (final p in _plans)
            Container(
              margin: const EdgeInsets.only(bottom: 10),
              decoration: BoxDecoration(
                borderRadius: BorderRadius.circular(18),
                gradient: p.$1 == _plan
                    ? const LinearGradient(colors: [Color(0xFFEDEBFF), Color(0xFFE8F8EE)])
                    : const LinearGradient(colors: [Color(0xFFF7F7FB), Color(0xFFF0F2F8)]),
                border: Border.all(color: p.$1 == _plan ? const Color(0xFF0E08A3) : Colors.transparent, width: 1.5),
              ),
              child: RadioListTile<String>(
                value: p.$1,
                groupValue: _plan,
                onChanged: (v) => setState(() => _plan = v ?? 'monthly'),
                title: Text(p.$2, style: const TextStyle(fontWeight: FontWeight.w600)),
                subtitle: Text('${p.$3} · ${p.$4}'),
              ),
            ),
          if (_error != null) ...[
            const SizedBox(height: 10),
            Text(_error!, style: TextStyle(color: cs.error)),
          ],
          const SizedBox(height: 10),
          FilledButton(
            onPressed: _busy ? null : _pay,
            style: FilledButton.styleFrom(minimumSize: const Size.fromHeight(52), shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(16))),
            child: Text(_busy ? 'Opening payment page…' : 'Continue to secure payment'),
          ),
          const SizedBox(height: 10),
          const Text('Payments are processed by Paystack (Nigeria) or Creem (international). Sentri never sees your card details.', textAlign: TextAlign.center),
        ],
      ),
    );
  }
}
