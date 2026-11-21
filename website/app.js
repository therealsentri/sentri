const API = 'https://sentri-api.onrender.com';

const store = {
  get() {
    try { return JSON.parse(localStorage.getItem('sentri.auth') || 'null'); } catch { return null; }
  },
  set(v) { localStorage.setItem('sentri.auth', JSON.stringify(v)); },
  clear() { localStorage.removeItem('sentri.auth'); },
};

const $ = (id) => document.getElementById(id);
const show = (id) => {
  for (const s of ['screen-intro', 'screen-signin', 'screen-alerts']) $(s).classList.toggle('hidden', s !== id);
};
const note = (id, msg) => { const e = $(id); e.textContent = msg; e.classList.toggle('hidden', !msg); };
const fail = (id, msg) => note(id, msg || '');

async function api(path, opts = {}) {
  const auth = store.get();
  const res = await fetch(API + path, {
    ...opts,
    headers: {
      'content-type': 'application/json',
      ...(auth?.accessToken ? { authorization: 'Bearer ' + auth.accessToken } : {}),
      ...(opts.headers || {}),
    },
  });
  // The access token is short-lived: one silent refresh, then replay.
  if (res.status === 401 && auth?.refreshToken && auth?.deviceId) {
    const r = await fetch(API + '/v1/auth/refresh', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ deviceId: auth.deviceId, refreshToken: auth.refreshToken }),
    });
    if (r.ok) {
      const j = await r.json();
      store.set({ ...auth, accessToken: j.accessToken, refreshToken: j.refreshToken });
      return api(path, opts);
    }
    store.clear();
    show('screen-intro');
  }
  return res;
}

/** The browser's VAPID public key arrives base64url; PushManager wants the bytes. */
function b64urlToU8(s) {
  const b = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(b, (c) => c.charCodeAt(0));
}

/** Keys the API's verify endpoint requires for any platform; the site has none of
 *  the app's ECDH pairing machinery, so it registers throwaway device keys. */
const webKeys = () => btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));

const installed = () =>
  window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;

const isIos = () => /iphone|ipad|ipod/i.test(navigator.userAgent) && !/crios|fxios/i.test(navigator.userAgent);

async function subscribe() {
  const perm = await Notification.requestPermission(); // called straight from the tap: iOS requires this
  if (perm !== 'granted') throw new Error('Permission was not granted');
  const res = await fetch(API + '/v1/webpush/public-key');
  if (!res.ok) throw new Error('The alert service did not answer');
  const { publicKey } = await res.json();
  const reg = await navigator.serviceWorker.register('sw.js');
  await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64urlToU8(publicKey) });
  const k = sub.toJSON();
  const save = await api('/v1/me/webpush', {
    method: 'POST',
    body: JSON.stringify({ endpoint: sub.endpoint, keys: { p256dh: k.keys.p256dh, auth: k.keys.auth } }),
  });
  if (!save.ok && save.status !== 401) throw new Error('Could not reach the alert service');
  return true;
}

async function refreshAlertsState() {
  const reg = await navigator.serviceWorker.getRegistration();
  const sub = reg ? await reg.pushManager.getSubscription() : null;
  if (sub) {
    $('alerts-state').textContent = 'You are protected: alerts will ring this phone.';
    $('btn-allow').textContent = 'Alerts on - tap to re-enable';
  } else {
    $('alerts-state').textContent = 'One tap, then your phone is protected.';
    $('btn-allow').textContent = 'Allow emergency alerts';
  }
}

function wire() {
  const auth = store.get();
  if (auth?.accessToken || auth?.deviceId) {
    show('screen-alerts');
    if (!installed()) $('add-to-hs').classList.remove('hidden');
    navigator.serviceWorker?.register('sw.js').catch(() => {});
    refreshAlertsState().catch(() => {});
  } else {
    show('screen-intro');
  }

  $('btn-start').addEventListener('click', () => show('screen-signin'));

  $('form-phone').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    fail('signin-err');
    $('btn-otp').disabled = true;
    try {
      const res = await fetch(API + '/v1/auth/otp/request', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ phone: $('phone').value.trim() }),
      });
      if (res.status === 429) throw new Error('Too many attempts - wait a minute and try again.');
      if (!res.ok) throw new Error('That number was not accepted. Check it and try again.');
      const j = await res.json().catch(() => ({}));
      if (j.telegramUrl) {
        $('telegram-link').href = j.telegramUrl;
        $('telegram-note').classList.remove('hidden');
      }
      $('form-code').classList.remove('hidden');
      $('code').focus();
    } catch (e) {
      fail('signin-err', e.message || 'Something went wrong.');
    } finally {
      $('btn-otp').disabled = false;
    }
  });

  $('form-code').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    fail('signin-err');
    $('btn-verify').disabled = true;
    try {
      const res = await fetch(API + '/v1/auth/otp/verify', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          phone: $('phone').value.trim(),
          code: $('code').value.trim(),
          platform: 'web',
          publicKey: webKeys(),
          boxPublicKey: webKeys(),
        }),
      });
      if (res.status === 401) throw new Error('That code is not right.');
      if (res.status === 429) throw new Error('Too many attempts - wait a minute.');
      if (!res.ok) throw new Error('Sign-in failed. Try again.');
      const j = await res.json();
      store.set({ accessToken: j.accessToken, refreshToken: j.refreshToken, deviceId: j.deviceId });
      show('screen-alerts');
      if (!installed()) $('add-to-hs').classList.remove('hidden');
      refreshAlertsState().catch(() => {});
    } catch (e) {
      fail('signin-err', e.message || 'Something went wrong.');
    } finally {
      $('btn-verify').disabled = false;
    }
  });

  $('btn-allow').addEventListener('click', async () => {
    fail('alerts-err');
    $('btn-allow').disabled = true;
    try {
      await subscribe();
      $('telegram-note').classList.add('hidden');
      $('alerts-state').textContent = 'You are protected: alerts will ring this phone.';
      $('btn-allow').textContent = 'Alerts on';
    } catch (e) {
      fail('alerts-err', e.message || 'Could not enable alerts.');
    } finally {
      $('btn-allow').disabled = false;
    }
  });

  $('signout').addEventListener('click', (ev) => {
    ev.preventDefault();
    store.clear();
    show('screen-intro');
  });
}

wire();
