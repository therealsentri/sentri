import 'package:flutter/material.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../core/net/api.dart';
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

  Future<void> _map() async {
    final f = _fix;
    if (f == null) return;
    final uri = Uri.parse('https://www.openstreetmap.org/?mlat=${f.lat}&mlon=${f.lon}#map=17/${f.lat}/${f.lon}');
    await launchUrl(uri, mode: LaunchMode.externalApplication);
  }

  @override
  Widget build(BuildContext context) {
    final cs = Theme.of(context).colorScheme;
    return Scaffold(
      appBar: AppBar(title: const Text('Find my phone')),
      body: ListView(
        padding: const EdgeInsets.all(18),
        children: [
          const Text('Sentri finds your phone', style: TextStyle(fontSize: 22, fontWeight: FontWeight.w600)),
          const SizedBox(height: 8),
          const Text('No Google account needed. Sentri rings your own devices at full volume and shows the last place your phone reported.'),
          const SizedBox(height: 18),
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
          const SizedBox(height: 24),
          const Divider(),
          const SizedBox(height: 12),
          const Text('Talk to us', style: TextStyle(fontSize: 20, fontWeight: FontWeight.w600)),
          const SizedBox(height: 8),
          const Text('Something wrong or an idea? Tell us before you leave a review — we read every message.'),
          const SizedBox(height: 12),
          FilledButton.tonal(
            onPressed: () => launchUrl(Uri.parse('mailto:therealsentri@gmail.com?subject=Sentri%20feedback'), mode: LaunchMode.externalApplication),
            child: const Text('Send feedback'),
          ),
        ],
      ),
    );
  }
}
