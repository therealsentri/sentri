/* Sentri's service worker: the thing that makes the emergency bell work.
 *
 * One rule above all: EVERY push must show a notification. Safari (iOS)
 * permanently revokes a site's push permission the first time a push
 * arrives and nothing is displayed, so there is no silent path here.
 */
const CACHE = 'sentri-v3';
const ROOT = new URL('./', self.registration.scope);
const P = (f) => new URL(f, ROOT).pathname;
const SHELL = ['index.html', 'app.html', 'style.css', 'landing.css', 'app.js', 'manifest.webmanifest', 'icons/icon-192.png', 'icons/icon-512.png'].map(P);

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

const URGENT = ['sos', 'duress', 'offline'];

self.addEventListener('push', (event) => {
  let d = {};
  try {
    d = event.data ? event.data.json() : {};
  } catch {
    // unreadable body: still show something, permission is at stake
  }
  const urgent = URGENT.includes(d.kind);
  const text = d.text || 'Emergency alert';
  // The quiet "clear" copy (kind 'clear') reuses the alert's tag so the
  // browser REPLACES the ringing notification: the alarm stops the moment
  // someone responds, exactly like it does inside the app.
  const opts = {
    body: text,
    tag: d.inboxId ?? d.sosId ?? undefined,
    renotify: true,
    icon: P('icons/icon-192.png'),
    badge: P('icons/icon-192.png'),
    data: { url: P('index.html') },
    actions: [],
  };
  if ('vibrate' in Notification.prototype) opts.vibrate = urgent ? [300, 120, 300, 120, 600] : [];
  event.waitUntil(self.registration.showNotification('Sentri', opts));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    (async () => {
      const url = (event.notification.data && event.notification.data.url) || P('index.html');
      const clientList = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const client of clientList) {
        if ('focus' in client) return client.focus();
      }
      return self.clients.openWindow(url);
    })(),
  );
});
