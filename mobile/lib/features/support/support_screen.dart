import 'package:flutter/material.dart';
import 'package:url_launcher/url_launcher.dart';

import '../core/net/api.dart';
import '../location/location.dart';

/// v52: two things the app was missing — a straight path to finding a lost
/// phone, and a real feedback route instead of a one-star review.
class SupportScreen extends StatefulWidget {
  const SupportScreen({super.key, required this.location});
  final LocationSource location;

  @override
  State<SupportScreen> createState() => _SupportScreenState();
}

class _SupportScreenState extends State<SupportScreen> {
  final _note = TextEditingController();
  String? _lastPlace;
  GeoFix? _fix;

  @override
  void initState() {
    super.initState();
    widget.location.lastKnown().then((f) {
      if (!mounted || f == null) return;
      setState(() {
        _fix = f;
        _lastPlace = 'https://www.openstreetmap.org/?mlat=${f.lat}&mlon=${f.lon}#map=17/${f.lat}/${f.lon}';
      });
    }).catchError((_) {});
  }

  @override
  void dispose() {
    _note.dispose();
    super.dispose();
  }

  Future<void> _open(Uri uri) async {
    final ok = await launchUrl(uri, mode: LaunchMode.externalApplication);
    if (!ok && mounted) ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Could not open the page. Check your browser.')));
  }

  @override
  Widget build(BuildContext context) {
    final cs = Theme.of(context).colorScheme;
    return Scaffold(
      appBar: AppBar(title: const Text('Find my phone & feedback')),
      body: ListView(
        padding: const EdgeInsets.all(18),
        children: [
          Text('Find my phone', style: Theme.of(context).textTheme.headlineSmall),
          const SizedBox(height: 8),
          const Text('Sentri keeps the last place your phone reported during an emergency. For a phone that is simply lost or stolen, use the device tools below — they work even when the phone is switched off.'),
          const SizedBox(height: 16),
          if (_lastPlace != null)
            Card(
              child: ListTile(
                leading: Icon(Icons.map_outlined, color: cs.primary),
                title: const Text('Last location on the map'),
                subtitle: Text('${_fix!.lat.toStringAsFixed(5)}, ${_fix!.lon.toStringAsFixed(5)}'),
                trailing: const Icon(Icons.open_in_new),
                onTap: () => _open(Uri.parse(_lastPlace!)),
              ),
            ),
          Card(
            child: ListTile(
              leading: Icon(Icons.phone_android, color: cs.primary),
              title: const Text('Open Google Find My Device'),
              subtitle: const Text('Locate, ring, lock or erase an Android phone'),
              trailing: const Icon(Icons.open_in_new),
              onTap: () => _open(Uri.parse('https://www.google.com/android/find')),
            ),
          ),
          Card(
            child: ListTile(
              leading: Icon(Icons.lock_outline, color: cs.primary),
              title: const Text('Remotely lock by phone number'),
              subtitle: const Text('android.com/lock — no sign-in needed'),
              trailing: const Icon(Icons.open_in_new),
              onTap: () => _open(Uri.parse('https://www.android.com/lock/')),
            ),
          ),
          const Divider(height: 36),
          Text('Talk to us', style: Theme.of(context).textTheme.headlineSmall),
          const SizedBox(height: 8),
          const Text('Something wrong, an idea, or a feature you need? Tell us before you leave a review — we read every message.'),
          const SizedBox(height: 14),
          TextField(
            controller: _note,
            maxLines: 5,
            decoration: const InputDecoration(border: OutlineInputBorder(), hintText: 'What happened? What would you change?'),
          ),
          const SizedBox(height: 12),
          FilledButton(
            onPressed: () {
              final body = Uri.encodeComponent(_note.text.trim().isEmpty ? 'Hello Sentri team,' : _note.text.trim());
              _open(Uri.parse('mailto:therealsentri@gmail.com?subject=Sentri%20feedback&body=$body'));
            },
            child: const Text('Send feedback'),
          ),
          const SizedBox(height: 8),
          const Text('Opens your email app with the message ready to send.', textAlign: TextAlign.center),
        ],
      ),
    );
  }
}
