import 'dart:async';

import 'package:cryptography_flutter/cryptography_flutter.dart';
import 'package:flutter/material.dart';

import 'app.dart';
import 'core/poppins.dart';
import 'features/billing/premium_state.dart';
import 'services.dart';

/// v55: render something on the very first frame. Every slow or failing
/// startup step happens after runApp, so the app can never show a blank screen.
void main() {
  WidgetsFlutterBinding.ensureInitialized();
  FlutterCryptography.enable();
  final holder = ValueNotifier<Widget>(const _BootScreen());
  runApp(ValueListenableBuilder<Widget>(
    valueListenable: holder,
    builder: (_, child, __) => child,
  ));
  unawaited(_boot(holder));
}

Future<void> _boot(ValueNotifier<Widget> holder) async {
  try {
    await BrandPoppins.ensure().catchError((_) {});
    final services = await AppServices.create();
    PremiumState.bind(services.api, store: services.store);
    // Never block the first frame on billing; refresh in the background.
    unawaited(PremiumState.refresh());
    holder.value = SentriApp(services: services);
  } catch (e, st) {
    debugPrint('startup failed: $e\n$st');
    holder.value = _BootError(onRetry: () => unawaited(_boot(holder)));
  }
}

class _BootScreen extends StatelessWidget {
  const _BootScreen();
  @override
  Widget build(BuildContext context) => const MaterialApp(
        home: Scaffold(
          body: Center(
            child: CircularProgressIndicator(color: Color(0xFF0E08A3)),
          ),
        ),
      );
}

class _BootError extends StatelessWidget {
  const _BootError({required this.onRetry});
  final VoidCallback onRetry;
  @override
  Widget build(BuildContext context) => MaterialApp(
        home: Scaffold(
          body: Center(
            child: Padding(
              padding: const EdgeInsets.all(24),
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  const Text('Sentri could not start', textAlign: TextAlign.center, style: TextStyle(fontSize: 20)),
                  const SizedBox(height: 10),
                  const Text('Your data is safe. Check your connection and try again.', textAlign: TextAlign.center),
                  const SizedBox(height: 18),
                  FilledButton(onPressed: onRetry, child: const Text('Try again')),
                ],
              ),
            ),
          ),
        ),
      );
}
