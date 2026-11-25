import 'package:flutter/material.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../core/net/api.dart';
import '../billing/premium_state.dart';
import '../billing/upgrade_screen.dart';
import '../location/location.dart';

/// v53: Sentri's own Find my phone. A ring is pushed to the person's own
/// devices through Sentri, with their last reported place on a map — no Google.
class SupportScreen extends StatefulWidget {
  const SupportScreen({super.key, required this.api, required this.location});
  final SentriApi api;
  final LocationSource location;

  @override
  State<SupportScreen> createState() => _SupportScreenState();
}

class _SupportScreenState extends State<SupportScreen> {
  GeoFix? _fix;
  bool _ringing = false;
  String? _note;

  @override
  void initState() {
    super.initState();
    widget.location.lastKnown().then((f) {
      if (mounted) setState(() => _fix = f);
    }).catchError((_) {});
  }

  Future<void> _ring() async {
    setState(() { _ringing = true; _note = null; });
    try {
      final ok = await widget.api.ringMyPhone();
      if (!mounted) return;
      setState(() {
        _ringing = false;
        _note = ok ? 'Your Sentri devices are ringing.' : 'No device received the ring — check your connection.';
      });
    } catch (_) {
      if (mounted) setState(() { _ringing = false; _note = 'Could not send the ring. Check your connection.'; });
    }
  }

  Future<void> _open(Uri uri) async {
    try {
      await launchUrl(uri, mode: LaunchMode.externalApplication);
    } catch (_) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Could not open the page.')));
    }
  }

  Future<void> _map() async {
    final f = _fix;
    if (f == null) return;
    await _open(Uri.parse('https://www.openstreetmap.org/?mlat=${f.lat}&mlon=${f.lon}#map=17/${f.lat}/${f.lon}'));
  }

  @override
  Widget build(BuildContext context) {
    final cs = Theme.of(context).colorScheme;
    return Scaffold(
      appBar: AppBar(title: const Text('Find my phone')),
      body: ListView(
        padding: const EdgeInsets.all(18),
        children: [
          ListenableBuilder(
            listenable: PremiumState.instance,
            builder: (context, _) => Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                const Text('Sentri finds your phone', style: TextStyle(fontSize: 22, fontWeight: FontWeight.w600)),
                const SizedBox(height: 8),
                const Text('No Google account needed. Sentri rings your own devices at full volume and shows the last place your phone reported.'),
                const SizedBox(height: 18),
                if (!PremiumState.instance.premium)
                  Card(
                    color: cs.primaryContainer,
                    child: Padding(
                      padding: const EdgeInsets.all(18),
                      child: Column(
                        children: [
                          Icon(Icons.workspace_premium_outlined, size: 40, color: cs.primary),
                          const SizedBox(height: 10),
                          const Text('Find my phone is a Premium feature', textAlign: TextAlign.center, style: TextStyle(fontSize: 17, fontWeight: FontWeight.w600)),
                          const SizedBox(height: 6),
                          const Text('Upgrade to ring your own devices from anywhere, with your last reported place.', textAlign: TextAlign.center),
                          const SizedBox(height: 14),
                          FilledButton(
                            onPressed: () => Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => UpgradeScreen(api: widget.api))),
                            child: const Text('See plans'),
                          ),
                        ],
                      ),
                    ),
                  )
                else ...[
                  if (_fix != null)
                    Card(
                      child: ListTile(
                        leading: Icon(Icons.map_outlined, color: cs.primary),
                        title: const Text('Last reported place'),
                        subtitle: Text('${_fix!.lat.toStringAsFixed(5)}, ${_fix!.lon.toStringAsFixed(5)}'),
                        trailing: const Icon(Icons.open_in_new),
                        onTap: _map,
                      ),
                    ),
                  const SizedBox(height: 10),
                  FilledButton(
                    onPressed: _ringing ? null : _ring,
                    style: FilledButton.styleFrom(minimumSize: const Size.fromHeight(52)),
                    child: Text(_ringing ? 'Ringing your devices…' : 'Ring my phone'),
                  ),
                  if (_note != null) ...[
                    const SizedBox(height: 12),
                    Text(_note!, textAlign: TextAlign.center),
                  ],
                ],
              ],
            ),
          ),
          const SizedBox(height: 24),
          const Divider(),
          const SizedBox(height: 12),
          const Text('Talk to us', style: TextStyle(fontSize: 20, fontWeight: FontWeight.w600)),
          const SizedBox(height: 8),
          const Text('Something wrong or an idea? Tell us before you leave a review — we read every message.'),
          const SizedBox(height: 12),
          FilledButton.tonal(
            onPressed: () => _open(Uri.parse('mailto:therealsentri@gmail.com?subject=Sentri%20feedback')),
            child: const Text('Send feedback'),
          ),
        ],
      ),
    );
  }
}
