import 'dart:async';
import 'dart:io' show Platform;
import 'dart:typed_data';
import 'dart:ui' show lerpDouble;
import 'package:flutter/material.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../core/emergency.dart';
import '../../core/i18n/i18n.dart';
import '../photos/photo_police.dart';
import '../photos24/photo_police_world.dart';
import 'police_directory.dart';

/// Digits only (plus a leading +), so a copied line with spaces dials correctly.
String _dialable(String l) => '+${l.replaceAll(RegExp(r'[^0-9]'), '')}'.replaceFirst('++', '+');

/// Lists every state command with its public lines. Numbers are selectable so they can be copied
/// — and now they can be dialled right there: one tap on the green call button beside a line,
/// no copy-paste needed. Shows the command for the user's current state first, when known.
///
/// v41, global: the person's own country decides the tab. Nigeria keeps the full NPF
/// command directory; every other country shows only the emergency lines that actually
/// answer there - never Nigerian police numbers.
class PoliceScreen extends StatelessWidget {
  const PoliceScreen({super.key, required this.directory, required this.i18n, this.currentState, this.country});
  final PoliceDirectory? directory;
  final I18n i18n;
  final String? currentState;

  /// The person's own country, resolved by the app shell from the phone number they
  /// signed up with (v41). Null falls back to the device's region on the phone.
  final SentriCountry? country;

  @override
  Widget build(BuildContext context) {
    final t = i18n.t;
    final dir = directory;
    return Scaffold(
      appBar: AppBar(title: Text(t('tabs.police'))),
      body: dir == null
          ? const Center(child: CircularProgressIndicator())
          : _ParallaxList(dir: dir, i18n: i18n, state: currentState, country: country),
    );
  }
}

/// Holds the scroll offset so the banner above can slide while the list moves.
/// A plain StatefulWidget rebuilds the list with the latest offset; cheap and honest.
/// The directory (non-null by the time it gets here), the language and the user's
/// state are handed over as widget fields, so nothing nullable is ever captured
/// inside this object's closures.
class _ParallaxList extends StatefulWidget {
  const _ParallaxList({required this.dir, required this.i18n, this.state, this.country});
  final PoliceDirectory dir;
  final I18n i18n;
  final String? state;

  /// The person's own country (v41) - overrides the device's region.
  final SentriCountry? country;
  @override
  State<_ParallaxList> createState() => _ParallaxListState();
}

class _ParallaxListState extends State<_ParallaxList> {
  double _offset = 0;

  @override
  Widget build(BuildContext context) {
    final t = widget.i18n.t;
    final cs = Theme.of(context).colorScheme;
    final dir = widget.dir;
    final mine = dir.forState(widget.state);
    // v41, global: the person's own country first - the number they signed up
    // with decides, not the phone's SIM - falling back to the device's region.
    // Nigeria is the one country with its own full command directory; for every
    // other country the emergency-lines card is the whole tab.
    final country = widget.country ?? countryForLocale(Platform.localeName);
    final ngLayout = country == null || country.iso == 'ng';
    return NotificationListener<ScrollNotification>(
      onNotification: (n) {
        if (n.metrics.axis == Axis.vertical && n.metrics.pixels != _offset) {
          setState(() => _offset = n.metrics.pixels);
        }
        return false;
      },
      child: ListView(
        // Bouncy pull like the rest of the refreshed screens.
        physics: const AlwaysScrollableScrollPhysics(parent: BouncingScrollPhysics()),
        padding: const EdgeInsets.fromLTRB(20, 8, 20, 32),
        children: [
          // The NPF banner and directory are Nigeria's own: shown for Nigeria
          // (and when the country is simply unknown). Everywhere else the tab
          // is the world card only (v41).
          if (ngLayout) ...[
            // The tab opens on a real officer's face, not on a form: a Nigerian
            // police banner that slides gently as the page scrolls (parallax).
            ClipRRect(
              borderRadius: BorderRadius.circular(24),
              child: SizedBox(
                height: 150,
                child: Stack(
                  fit: StackFit.expand,
                  children: [
                    Transform.translate(
                      offset: Offset(0, (-_offset * 0.35).clamp(-60.0, 60.0)),
                      child: Image.memory(photoPoliceBytes, fit: BoxFit.cover, gaplessPlayback: true),
                    ),
                    Align(
                      alignment: Alignment.bottomCenter,
                      child: Container(
                        decoration: const BoxDecoration(
                          gradient: LinearGradient(
                            begin: Alignment.bottomCenter,
                            end: Alignment.topCenter,
                            colors: [Color(0x66000000), Color(0x00000000)],
                          ),
                        ),
                      ),
                    ),
                  ],
                ),
              ),
            ),
            const SizedBox(height: 18),
          ],
          if (mine != null) ...[
            Text(t('police.your_state').toUpperCase(), style: Theme.of(context).textTheme.labelMedium?.copyWith(letterSpacing: 1.1, color: cs.outline)),
            const SizedBox(height: 8),
            Card(child: _CommandTile(mine, widget.i18n)),
            const SizedBox(height: 20),
          ],
          // The world's lines for this phone's country: police, fire and ambulance,
          // each one tappable, no copy-paste. Only shown when a country is known.
          // v42: the country also gets its region's police and firefighter
          // photos, so the tab opens on real faces from the person's part of the
          // world, not only Nigerian ones. Photos decode once and are cached.
          if (country != null) ...[
            if (policePhotoForCountry(country.iso) case final policePhoto?) ...[
              ClipRRect(
                borderRadius: BorderRadius.circular(24),
                child: SizedBox(
                  height: 150,
                  child: Stack(
                    fit: StackFit.expand,
                    children: [
                      Transform.translate(
                        offset: Offset(0, (-_offset * 0.35).clamp(-60.0, 60.0)),
                        child: Image.memory(policePhoto, fit: BoxFit.cover, gaplessPlayback: true),
                      ),
                      Align(
                        alignment: Alignment.bottomCenter,
                        child: Container(
                          decoration: const BoxDecoration(
                            gradient: LinearGradient(
                              begin: Alignment.bottomCenter,
                              end: Alignment.topCenter,
                              colors: [Color(0x66000000), Color(0x00000000)],
                            ),
                          ),
                        ),
                      ),
                      Align(
                        alignment: Alignment.bottomLeft,
                        child: Padding(
                          padding: const EdgeInsets.fromLTRB(16, 0, 16, 12),
                          child: Text(
                            '${country.flag}  ${country.name}',
                            style: const TextStyle(color: Colors.white, fontSize: 14, fontWeight: FontWeight.w700, shadows: [Shadow(color: Color(0x99000000), blurRadius: 8, offset: Offset(0, 1))]),
                          ),
                        ),
                      ),
                    ],
                  ),
                ),
              ),
              const SizedBox(height: 14),
            ],
            Card(
              child: Padding(
                padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 14),
                child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  Row(children: [
                    Text(country.flag, style: const TextStyle(fontSize: 20)),
                    const SizedBox(width: 8),
                    Expanded(child: Text(t('emergency.title', {'name': country.name}), style: Theme.of(context).textTheme.titleMedium)),
                  ]),
                  const SizedBox(height: 6),
                  for (final s in const [('emergency.police', 'police'), ('emergency.fire', 'fire'), ('emergency.ambulance', 'ambulance')])
                    Row(children: [
                      Expanded(child: Text(t(s.$1), style: const TextStyle(fontSize: 14.5, fontWeight: FontWeight.w600))),
                      const SizedBox(width: 8),
                      Text(switch (s.$2) { 'police' => country.police, 'fire' => country.fire, _ => country.ambulance },
                        style: const TextStyle(fontSize: 16, fontWeight: FontWeight.w700, fontFeatures: [FontFeature.tabularFigures()])),
                      IconButton(
                        tooltip: t('health.call'),
                        visualDensity: VisualDensity.compact,
                        icon: Icon(Icons.call, color: cs.primary),
                        onPressed: () {
                          final n = switch (s.$2) { 'police' => country.police, 'fire' => country.fire, _ => country.ambulance };
                          unawaited(launchUrl(Uri(scheme: 'tel', path: n), mode: LaunchMode.externalApplication).catchError((_) => false));
                        },
                      ),
                    ]),
                  const SizedBox(height: 2),
                  Text(t('emergency.note'), style: TextStyle(fontSize: 12.5, height: 1.35, color: cs.outline)),
                ]),
              ),
            ),
            // v42: the region's firefighters, right under the lines. Labelled
            // with the same words the card uses, so nothing new has to be read.
            if (firePhotoForCountry(country.iso) case final firePhoto?) ...[
              const SizedBox(height: 14),
              ClipRRect(
                borderRadius: BorderRadius.circular(20),
                child: SizedBox(
                  height: 120,
                  child: Stack(
                    fit: StackFit.expand,
                    children: [
                      Image.memory(firePhoto, fit: BoxFit.cover, gaplessPlayback: true),
                      Align(
                        alignment: Alignment.bottomLeft,
                        child: Padding(
                          padding: const EdgeInsets.fromLTRB(14, 0, 14, 10),
                          child: Text(
                            '${country.flag}  ${t('emergency.fire')}',
                            style: const TextStyle(color: Colors.white, fontSize: 13, fontWeight: FontWeight.w700, shadows: [Shadow(color: Color(0x99000000), blurRadius: 8, offset: Offset(0, 1))]),
                          ),
                        ),
                      ),
                    ],
                  ),
                ),
              ),
            ],
            const SizedBox(height: 20),
          ],
          // v43: the world reel, v45 a CARD DECK - every police and firefighter
          // photo in the library, from eight regions and four fire services,
          // dealt away one by one like a fanned hand of cards. A gentle timer
          // deals the front card every few seconds; a drag by the person deals
          // it themselves, or springs it back.
          // Shown for every country: the photos are a tour of the world's
          // forces, not this country's own.
          Text(t('police.gallery_note').toUpperCase(), style: Theme.of(context).textTheme.labelMedium?.copyWith(letterSpacing: 1.1, color: cs.outline)),
          const SizedBox(height: 10),
          const _WorldGallery(),
          const SizedBox(height: 20),
          if (ngLayout) ...[
            Text(t('police.note'), style: Theme.of(context).textTheme.bodyMedium),
            const SizedBox(height: 16),
            Text(t('police.all').toUpperCase(), style: Theme.of(context).textTheme.labelMedium?.copyWith(letterSpacing: 1.1, color: cs.outline)),
            const SizedBox(height: 8),
            Card(
              child: Column(
                children: [
                  for (var i = 0; i < dir.commands.length; i++) ...[
                    if (i > 0) const Divider(height: 1),
                    _CommandTile(dir.commands[i], widget.i18n),
                  ],
                ],
              ),
            ),
          ] else ...[
            const SizedBox(height: 16),
            Text(t('police.global_note'), style: TextStyle(fontSize: 13, height: 1.45, color: cs.outline)),
          ],
        ],
      ),
    );
  }
}

class _CommandTile extends StatelessWidget {
  const _CommandTile(this.c, this.i18n);
  final PoliceCommand c;
  final I18n i18n;

  @override
  Widget build(BuildContext context) {
    final cs = Theme.of(context).colorScheme;
    final official = c.verified || c.npfListed;
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 14),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Expanded(child: Text(c.state, style: Theme.of(context).textTheme.titleMedium)),
              if (official)
                Container(
                  padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
                  decoration: BoxDecoration(
                    borderRadius: BorderRadius.circular(99),
                    border: Border.all(color: cs.tertiary),
                  ),
                  child: Text(
                    i18n.t(c.verified ? 'police.verified' : 'police.listed'),
                    style: TextStyle(fontSize: 11, fontWeight: FontWeight.w600, color: cs.tertiary),
                  ),
                ),
            ],
          ),
          if (c.commissioner != null) ...[
            const SizedBox(height: 4),
            Text(
              '${i18n.t('police.commissioner')}: ${c.commissioner}',
              style: TextStyle(fontSize: 13, fontWeight: FontWeight.w600, color: cs.onSurface),
            ),
          ],
          const SizedBox(height: 6),
          for (final l in c.lines)
            Row(children: [
              Expanded(
                child: SelectableText(l, style: const TextStyle(fontSize: 16, fontWeight: FontWeight.w600, fontFeatures: [FontFeature.tabularFigures()])),
              ),
              // Only a real number line gets the call button: text lines like
              // "767 or 112 (toll-free)" would dial stripped nonsense digits.
              if (RegExp(r'^\+?[0-9][0-9 ()\-]{5,}$').hasMatch(l))
                IconButton(
                  tooltip: 'Call',
                  visualDensity: VisualDensity.compact,
                  icon: Icon(Icons.call, color: cs.primary),
                  onPressed: () {
                    final n = _dialable(l);
                    unawaited(launchUrl(Uri(scheme: 'tel', path: n), mode: LaunchMode.externalApplication).catchError((_) => false));
                  },
                ),
            ]),
        ],
      ),
    );
  }
}

/// One pose of a card in the deck: where it sits, how it tilts, how big it is.
class _Pose {
  const _Pose(this.dx, this.dy, this.angle, this.scale);
  final double dx;
  final double dy;
  final double angle;
  final double scale;

  static _Pose lerp(_Pose a, _Pose b, double t) => _Pose(
        lerpDouble(a.dx, b.dx, t)!,
        lerpDouble(a.dy, b.dy, t)!,
        lerpDouble(a.angle, b.angle, t)!,
        lerpDouble(a.scale, b.scale, t)!,
      );
}

/// Animates a card from one deck pose to another (TweenAnimationBuilder picks
/// the begin up from the card's current pose on its own).
class _PoseTween extends Tween<_Pose> {
  _PoseTween({required _Pose end}) : super(end: end);
  @override
  _Pose lerp(double t) => _Pose.lerp(begin ?? end!, end!, t);
}

/// The world gallery (v45): an auto-cycling CARD DECK of the police and
/// firefighter photos from around the world, styled after the fanned decks
/// dating apps use - a front card with two tucked behind it, tilted about
/// seven degrees off each other and slightly smaller, peeking at the edges.
///
/// How it stays pleasant instead of annoying:
/// * the deck deals the front card away every 3.2 seconds - it flies off with
///   a small tilt while the two cards behind grow into its place - and the
///   moment the person's own finger takes a card, the timer stands down;
/// * a drag that travels far enough (or is flung) deals the card away at once;
///   a short drag springs the card back to the front of the deck;
/// * the photos decode once (the photo file caches them) and the deck holds
///   only three live cards at a time, so this is no heavier than the old reel;
/// * NO captions, flags, place names or credits on the cards: countries without
///   a photo in the set must not be singled out by the ones that do. The
///   gallery note above and the dots below carry the context.
class _WorldGallery extends StatefulWidget {
  const _WorldGallery();

  @override
  State<_WorldGallery> createState() => _WorldGalleryState();
}

class _WorldGalleryState extends State<_WorldGallery> with SingleTickerProviderStateMixin {
  static const _cycle = Duration(milliseconds: 3200);
  static const _flyDur = Duration(milliseconds: 620);
  static const _settleDur = Duration(milliseconds: 420);
  static const _slide = 480.0;

  // The front card and the two tucked behind it: the fanned hand.
  static const _poses = [
    _Pose(0, 0, 0, 1),
    _Pose(-14, 6, -0.12, 0.94),
    _Pose(14, 12, 0.12, 0.88),
  ];

  late final AnimationController _fly = AnimationController(vsync: this, duration: _flyDur);
  Timer? _auto;
  bool _dragging = false;
  int _front = 0;
  double _dragDx = 0;
  int _exitSign = 1;

  int get _n => worldGalleryItems.length;

  @override
  void initState() {
    super.initState();
    _fly.addStatusListener((status) {
      if (status == AnimationStatus.completed && mounted) {
        setState(() => _front = (_front + 1) % _n);
        _fly.reset();
      }
    });
    _auto = Timer.periodic(_cycle, (_) {
      if (!mounted || _dragging || _fly.isAnimating) return;
      _exitSign = 1;
      _fly.forward(from: 0);
    });
  }

  @override
  void dispose() {
    _auto?.cancel();
    _fly.dispose();
    super.dispose();
  }

  /// Deals the front card away, taking over from wherever a drag left it so
  /// the card never jumps: the flight starts from the drag's own position.
  void _dealAway(double fromDx) {
    _exitSign = fromDx < 0 ? -1 : 1;
    final frac = (fromDx.abs() / _slide).clamp(0.001, 0.999);
    setState(() => _dragDx = 0);
    _fly.forward(from: frac);
  }

  @override
  Widget build(BuildContext context) {
    final cs = Theme.of(context).colorScheme;
    return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      GestureDetector(
        onHorizontalDragStart: (_) {
          _dragging = true;
          _auto?.cancel();
        },
        onHorizontalDragUpdate: (d) => setState(() => _dragDx = (_dragDx + d.delta.dx).clamp(-_slide, _slide)),
        onHorizontalDragEnd: (d) {
          _dragging = false;
          final vx = d.velocity.pixelsPerSecond.dx;
          if (_dragDx.abs() > 96 || vx.abs() > 700) {
            _dealAway(_dragDx == 0 ? vx.sign * 40 : _dragDx);
            _restartAuto();
          } else if (_dragDx.abs() > 4) {
            // A short drag springs the card back to the front of the deck.
            _exitSign = _dragDx < 0 ? -1 : 1;
            final frac = (_dragDx.abs() / _slide).clamp(0.001, 0.999);
            setState(() => _dragDx = 0);
            _fly.value = frac;
            _fly.reverse();
            _restartAuto();
          } else {
            _restartAuto();
          }
        },
        child: SizedBox(
          height: 292,
          child: AnimatedBuilder(
            animation: _fly,
            builder: (context, _) {
              final exiting = _dragDx != 0 || _fly.value > 0;
              return Stack(clipBehavior: Clip.none, children: [
                // Deepest first: the tucked cards sit under the front one,
                // and the dealt card rides above everything.
                for (var s = 2; s >= 0; s--)
                  _deckCard((_front + (exiting ? 1 : 0) + s) % _n, s),
                if (exiting) _flyingCard(),
              ]);
            },
          ),
        ),
      ),
      const SizedBox(height: 12),
      // The dots: one per photo, the front card's dot stretched wide.
      Row(
        mainAxisAlignment: MainAxisAlignment.center,
        children: [
          for (var i = 0; i < _n; i++)
            AnimatedContainer(
              duration: const Duration(milliseconds: 220),
              margin: const EdgeInsets.symmetric(horizontal: 3),
              height: 7,
              width: i == _front ? 18 : 7,
              decoration: BoxDecoration(
                color: i == _front ? cs.primary : cs.outline.withValues(alpha: 0.4),
                borderRadius: BorderRadius.circular(99),
              ),
            ),
        ],
      ),
    ]);
  }

  void _restartAuto() {
    _auto?.cancel();
    _auto = Timer.periodic(_cycle, (_) {
      if (!mounted || _dragging || _fly.isAnimating) return;
      _exitSign = 1;
      _fly.forward(from: 0);
    });
  }

  /// One card of the stack at its slot's pose. Keyed by the photo index so a
  /// card's own widget (and its cached image) survives a deal-away: when the
  /// deck shifts, each card animates from its old slot's pose to its new one.
  Widget _deckCard(int idx, int slot) {
    final bytes = worldGalleryPhoto(worldGalleryItems[idx].key);
    return TweenAnimationBuilder<_Pose>(
      key: ValueKey('deck-photo-$idx'),
      tween: _PoseTween(end: _poses[slot]),
      duration: _settleDur,
      curve: Curves.easeOutCubic,
      child: _photoCard(bytes),
      builder: (context, p, card) => _poseWrap(p, card!, 1),
    );
  }

  /// The card on its way out: it follows the finger while the hand holds it,
  /// then flies the rest of the way (or springs back) through the controller.
  Widget _flyingCard() {
    final flying = _fly.isAnimating;
    final dx = flying ? _exitSign * _fly.value * _slide : _dragDx;
    final t = flying ? _fly.value : _dragDx.abs() / _slide;
    final angle = (dx / 420).clamp(-0.55, 0.55);
    final bytes = worldGalleryPhoto(worldGalleryItems[_front].key);
    return Transform.translate(
      offset: Offset(dx, flying ? -_fly.value * 24 : 0),
      child: Transform.rotate(
        angle: angle,
        child: Opacity(
          opacity: (1 - t * 1.5).clamp(0.0, 1.0),
          child: _photoCard(bytes),
        ),
      ),
    );
  }

  Widget _poseWrap(_Pose p, Widget child, double opacity) {
    return Opacity(
      opacity: opacity,
      child: Transform.translate(
        offset: Offset(p.dx, p.dy),
        child: Transform.rotate(
          angle: p.angle,
          child: Transform.scale(scale: p.scale, child: child),
        ),
      ),
    );
  }

  Widget _photoCard(Uint8List? bytes) {
    final cs = Theme.of(context).colorScheme;
    return DecoratedBox(
      decoration: BoxDecoration(
        borderRadius: BorderRadius.circular(22),
        boxShadow: const [BoxShadow(color: Color(0x2E000000), blurRadius: 18, offset: Offset(0, 8))],
      ),
      child: ClipRRect(
        borderRadius: BorderRadius.circular(22),
        child: bytes == null
            ? ColoredBox(color: cs.surfaceContainerHighest)
            : Image.memory(bytes, fit: BoxFit.cover, gaplessPlayback: true),
      ),
    );
  }
}
