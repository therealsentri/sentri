import { createVerify, generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { FcmPushSender, type PushTokenStore } from '../src/modules/notify/fcm.js';

const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});
const account = { project_id: 'sentri-test', client_email: 'svc@sentri-test.iam.gserviceaccount.com', private_key: privateKey };

function rig(opts: { sendStatus?: number; sendBody?: unknown } = {}) {
  const forgotten: string[] = [];
  const store: PushTokenStore = {
    tokensForUser: async () => [{ deviceId: 'd1', token: 'tok1' }, { deviceId: 'd2', token: 'tok2' }],
    tokensForContact: async (id) => (id === 'none' ? [] : [{ deviceId: 'd9', token: 'tok9' }]),
    forgetToken: async (id) => void forgotten.push(id),
  };
  const calls: { url: string; body?: string; auth?: string }[] = [];
  let tokenCalls = 0;
  let now = 1_000_000;
  const fetchFn = (async (url: string, init: RequestInit) => {
    calls.push({ url, body: String(init.body), auth: (init.headers as Record<string, string>)?.authorization });
    if (url.includes('oauth2')) {
      tokenCalls++;
      return new Response(JSON.stringify({ access_token: `at${tokenCalls}`, expires_in: 3600 }), { status: 200 });
    }
    return new Response(JSON.stringify(opts.sendBody ?? {}), { status: opts.sendStatus ?? 200 });
  }) as unknown as typeof fetch;
  const sender = new FcmPushSender(store, account, fetchFn, () => now);
  return { sender, calls, forgotten, tick: (ms: number) => (now += ms), tokenCalls: () => tokenCalls };
}

const sendsOf = (r: { calls: { url: string; body?: string; auth?: string }[] }) => r.calls.filter((c) => c.url.includes('messages:send'));

describe('FcmPushSender', () => {
  it('signs a valid RS256 JWT for the token exchange', async () => {
    const r = rig();
    await r.sender.sendToUser('u1', { kind: 'sos', text: 'hi' });
    const form = new URLSearchParams(r.calls[0].body);
    const [h, c, s] = form.get('assertion')!.split('.');
    expect(JSON.parse(Buffer.from(h, 'base64url').toString())).toEqual({ alg: 'RS256', typ: 'JWT' });
    const claim = JSON.parse(Buffer.from(c, 'base64url').toString());
    expect(claim.iss).toBe(account.client_email);
    expect(claim.scope).toContain('firebase.messaging');
    expect(createVerify('RSA-SHA256').update(`${h}.${c}`).verify(publicKey, Buffer.from(s, 'base64url'))).toBe(true);
  });

  // v46: an emergency is no longer data-only. The message carries the data payload
  // (with the tray marker) AND the notification copy Android itself shows - that is
  // what makes the alert land in about a second on a phone whose app is closed.
  it('sends the emergency tray copy with its data to every device and reuses the access token', async () => {
    const r = rig();
    expect(await r.sender.sendToUser('u1', { kind: 'sos', text: 'help', sosId: 's1', inboxId: 'i-1' })).toBe(true);
    await r.sender.sendToUser('u1', { kind: 'sos', text: 'again' });
    expect(r.tokenCalls()).toBe(1);
    const sends = sendsOf(r);
    expect(sends).toHaveLength(4);
    const m = JSON.parse(sends[0].body!).message;
    expect(m.data).toEqual({ kind: 'sos', text: 'help', sosId: 's1', inboxId: 'i-1', tray: '1' });
    // The tray copy lives in the ANDROID platform block - that is the form the
    // system tray on the contact's phone reads.
    expect(m.android.notification).toEqual({ title: 'Sentri', body: 'help', channel_id: 'sentri_alerts', tag: 'i-1' });
    expect(m.android.priority).toBe('HIGH');
    expect(m.android.collapse_key).toBe('s1');
    expect(m.android.ttl).toBe('604800s');
    expect(sends[0].auth).toBe('Bearer at1');
    // The repeat round (sends[2] is the first device's copy of it - the two
    // devices interleave: [help->d1, help->d2, again->d1, again->d2]):
    // same shape, tag omitted when there is nothing to file it under.
    const m2 = JSON.parse(sends[2].body!).message;
    expect(m2.data).toEqual({ kind: 'sos', text: 'again', tray: '1' });
    expect(m2.android.notification).toEqual({ title: 'Sentri', body: 'again', channel_id: 'sentri_alerts' });
    expect(m2.android.collapse_key).toBeUndefined();
  });

  // v47: the iPhone mirror. APNs shows the alert on iOS, so the emergency classes
  // carry a real apns alert - title, body, sound, time-sensitive - and the same
  // collapse-id mechanism ties the repeat rounds and the clear copy together.
  it('sends the emergency as a real APNs alert on iOS, not silent data', async () => {
    const r = rig();
    await r.sender.sendToUser('u1', { kind: 'sos', text: 'help', sosId: 's1', inboxId: 'i-1' });
    await r.sender.sendToUser('u1', { kind: 'sos', text: 'again' });
    const m = JSON.parse(sendsOf(r)[0].body!).message;
    expect(m.apns.payload.aps).toEqual({
      'content-available': 1,
      alert: { title: 'Sentri', body: 'help' },
      sound: 'default',
      'interruption-level': 'time-sensitive',
    });
    expect(m.apns.headers['apns-priority']).toBe('10');
    expect(m.apns.headers['apns-collapse-id']).toBe('s1');
    // Repeat round (the two devices interleave: [help->d1, help->d2, again->d1,
    // again->d2] - so sends[2] is the first device's copy of it): same alert copy,
    // and the collapse id is omitted with nothing to tie it to.
    const m2 = JSON.parse(sendsOf(r)[2].body!).message;
    expect(m2.apns.payload.aps.alert).toEqual({ title: 'Sentri', body: 'again' });
    expect(m2.apns.headers['apns-collapse-id']).toBeUndefined();
  });

  // v46: the "clear" copy rides on the QUIET channel with the SAME tag, so Android
  // replaces the ringing notification and the alarm stops even with the app closed.
  it('rings the alert down quietly with the same tag when it ends', async () => {
    const r = rig();
    await r.sender.sendToUser('u1', { kind: 'clear', text: 'answered', sosId: 's1', inboxId: 'i-1' });
    const m = JSON.parse(sendsOf(r)[0].body!).message;
    expect(m.data).toEqual({ kind: 'clear', text: 'answered', sosId: 's1', inboxId: 'i-1', tray: '1' });
    expect(m.android.notification).toEqual({ title: 'Sentri', body: 'answered', channel_id: 'sentri_quiet', tag: 'i-1' });
    expect(m.android.ttl).toBe('604800s');
  });

  // v47: on iOS the clear copy is a QUIET alert that shares the ringing alert's
  // collapse id - APNs replaces (and thereby silences) the old one. No sound.
  it('silences the iPhone alert with a passive clear copy under the same collapse id', async () => {
    const r = rig();
    await r.sender.sendToUser('u1', { kind: 'clear', text: 'answered', sosId: 's1', inboxId: 'i-1' });
    const m = JSON.parse(sendsOf(r)[0].body!).message;
    expect(m.apns.payload.aps).toEqual({
      'content-available': 1,
      alert: { title: 'Sentri', body: 'answered' },
      'interruption-level': 'passive',
    });
    expect(m.apns.payload.aps.sound).toBeUndefined();
    expect(m.apns.headers['apns-collapse-id']).toBe('s1');
  });

  // v46: only the emergency kinds and the clear copy carry a notification. Everything
  // else stays data-only: it must boot the app's handler like before, silently.
  it('leaves non-emergency kinds data-only', async () => {
    const r = rig();
    await r.sender.sendToUser('u1', { kind: 'share_stop', text: 'done' });
    const m = JSON.parse(sendsOf(r)[0].body!).message;
    expect(m.data).toEqual({ kind: 'share_stop', text: 'done' });
    expect(m.android.notification).toBeUndefined();
    expect(m.android.ttl).toBe('60s');
    // v47: non-emergency kinds stay data-only on iOS too - content-available wakes
    // the app's handler exactly like before, silently.
    expect(m.apns.payload.aps).toEqual({ 'content-available': 1 });
  });

  it('refreshes the access token when it is about to expire', async () => {
    const r = rig();
    await r.sender.sendToUser('u1', { kind: 'sos', text: 'a' });
    r.tick(3_600_000);
    await r.sender.sendToUser('u1', { kind: 'sos', text: 'b' });
    expect(r.tokenCalls()).toBe(2);
  });

  it('returns false when there is nothing to send to', async () => {
    const r = rig();
    expect(await r.sender.sendToContact('none', { kind: 'sos', text: 'x' })).toBe(false);
    expect(r.calls).toHaveLength(0);
  });

  it('forgets tokens FCM says are gone, and never throws on failures', async () => {
    const r = rig({ sendStatus: 404, sendBody: { error: { status: 'UNREGISTERED' } } });
    expect(await r.sender.sendToUser('u1', { kind: 'sos', text: 'x' })).toBe(false);
    expect(r.forgotten.sort()).toEqual(['d1', 'd2']);
  });

  it('keeps tokens on a server error', async () => {
    const r = rig({ sendStatus: 503 });
    expect(await r.sender.sendToUser('u1', { kind: 'sos', text: 'x' })).toBe(false);
    expect(r.forgotten).toEqual([]);
  });
});
