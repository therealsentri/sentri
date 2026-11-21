import 'package:flutter/material.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../core/net/api.dart';
import '../../core/widgets/brand.dart';

/// v51: the only place in the app where a purchase starts. The decision about
/// what is unlocked lives on the server (users.plan), never here.
class UpgradeScreen extends StatefulWidget {
  const UpgradeScreen({super.key, required this.api});
  final SentriApi api;

  @override
  State<UpgradeScreen> createState() => _UpgradeScreenState();
}

class _UpgradeScreenState extends State<UpgradeScreen> {
  String _rail = 'paystack';
  String _plan = 'monthly';
  String? _current;
  String? _error;
  bool _busy = false;

  @override
  void initState() {
    super.initState();
    widget.api.billingStatus().then((s) {
      if (mounted) setState(() => _current = s['plan'] as String? ?? 'free');
    }).catchError((_) {});
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
        padding: const EdgeInsets.all(18),
        children: [
          const SentriTopBarMark(),
          const SizedBox(height: 12),
          Text('Safety stays free.', style: Theme.of(context).textTheme.headlineSmall),
          const SizedBox(height: 6),
          const Text('Premium adds travel safety, gyms near me, the health suite, water reminders, one-year history, unlimited contacts and watch features. Your emergency alarm never moves behind a paywall.'),
          const SizedBox(height: 18),
          if (_current != null && _current != 'free')
            Container(
              padding: const EdgeInsets.all(14),
              decoration: BoxDecoration(color: cs.primaryContainer, borderRadius: BorderRadius.circular(14)),
              child: Text('Current plan: $_current'),
            ),
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
            Card(
              child: RadioListTile<String>(
                value: p.$1,
                groupValue: _plan,
                onChanged: (v) => setState(() => _plan = v ?? 'monthly'),
                title: Text(p.$2),
                subtitle: Text('${p.$3} · ${p.$4}'),
              ),
            ),
          if (_error != null) ...[
            const SizedBox(height: 10),
            Text(_error!, style: TextStyle(color: cs.error)),
          ],
          const SizedBox(height: 18),
          FilledButton(
            onPressed: _busy ? null : _pay,
            child: Text(_busy ? 'Opening payment page…' : 'Continue to secure payment'),
          ),
          const SizedBox(height: 10),
          const Text('Payments are processed by Paystack (Nigeria) or Creem (international). Sentri never sees your card details.', textAlign: TextAlign.center),
        ],
      ),
    );
  }
}

class SentriTopBarMark extends StatelessWidget {
  const SentriTopBarMark({super.key});
  @override
  Widget build(BuildContext context) => const SentriMark(size: 44);
}
