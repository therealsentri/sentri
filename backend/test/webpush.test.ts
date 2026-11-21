import { createDecipheriv, createECDH, createPublicKey, createVerify, generateKeyPairSync, hkdfSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { FanoutPushSender, WebPushSender, encryptAes128Gcm, generateVapidKeys, type WebPushKeyStore, type WebPushSub } from '../src/modules/notify/webpush.js';
import type { PushSender } from '../src/modules/notify/contact-notifier.js';

/** raw r||s -> DER, so node's createVerify can check our ES256 JWT signature. */
function rawToDer(rawSig: Buffer): Buffer {
  const trim = (b: Buffer): Buffer => {
    let i = 0;
    while (i < b.length - 1 && b[i] === 0) i++;
    const t = b.subarray(i);
    return t[0] > 0x7f ? Buffer.concat([Buffer.from([0]), t]) : t;
  };
  const r = trim(rawSig.subarray(0, 32));
  const s = trim(rawSig.subarray(32));
  const body = Buffer.concat([Buffer.from([2, r.length]), r, Buffer.from([2, s.length]), s]);
  return Buffer.concat([Buffer.from([0x30, body.length]), body]);
}

/** The "browser" side of the rig: a real P-256 subscription the test can decrypt with. */
function browserKeys() {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  return {
    p256dh: ecdh.getPublicKey('base64url'),
    auth: Buffer.from('0123456789abcdef').toString('base64url'),
    ecdh,
  };
}

/** Reverses encryptAes128Gcm from the browser's side and returns the payload JSON. */
function decryptBody(body: Buffer, ecdh: ReturnType<typeof createECDH>, auth: string): string {
  const salt = body.subarray(0, 16);
  expect(body.readUInt32BE(16)).toBe(4096); // rs
  const idLen = body[20];
  const asPub = body.subarray(21, 21 + idLen);
  const ct = body.subarray(21 + idLen);
  const prk = Buffer.from(
    hkdfSync('sha256', Buffer.concat([ecdh.computeSecret(asPub), Buffer.from(auth, 'base64url')]), salt, Buffer.concat([Buffer.from('WebPush: info\0'), ecdh.getPublicKey(), asPub]), 32),
  );
  const cek = Buffer.from(hkdfSync('sha256', prk, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(hkdfSync('sha256', prk, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const decipher = createDecipheriv('aes-128-gcm', cek, nonce);
  decipher.setAuthTag(ct.subarray(ct.length - 16));
  const plaintext = Buffer.concat([decipher.update(ct.subarray(0, ct.length - 16)), decipher.final()]);
  expect(plaintext[plaintext.length - 1]).toBe(2); // padding delimiter
  expect(plaintext[plaintext.length - 2]).toBe(0); // at least one pad byte
  return plaintext.subarray(0, plaintext.length - 2).toString('utf8');
}

function rig(opts: { status?: number } = {}) {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const browser = browserKeys();
  const sub: WebPushSub = {
    id: 'w1',
    endpoint: 'https://push.example.com/send/abc',
    p256dh: browser.p256dh,
    auth: browser.auth,
  };
  const forgotten: string[] = [];
  const store: WebPushKeyStore = {
    keys: async () => ({
      publicKey: (publicKey.export({ type: 'spki', format: 'der' }) as Buffer).subarray(-65).toString('base64url'),
      privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    }),
    subsForUser: async () => [sub],
    subsForContact: async () => [],
    forget: async (id) => void forgotten.push(id),
  };
  const calls: { url: string; headers: Record<string, string>; body: Buffer }[] = [];
  const fetchFn = (async (url: string, init: RequestInit) => {
    calls.push({ url, headers: init.headers as Record<string, string>, body: init.body as Buffer });
    return new Response(null, { status: opts.status ?? 201 });
  }) as unknown as typeof fetch;
  const sender = new WebPushSender(store, 'mailto:test@sentri.example', fetchFn, () => 1_000_000);
  return { sender, calls, forgotten, browser, sub };
}

describe('generateVapidKeys', () => {
  it('produces a 65-byte public point and signs tokens that verify against it', () => {
    const k = generateVapidKeys();
    expect(Buffer.from(k.publicKey, 'base64url')).toHaveLength(65);
    expect(k.privateKey.startsWith('-----BEGIN PRIVATE KEY-----')).toBe(true);
    // The pair must be consistent: a JWT signed with the private key verifies
    // against the public point. node wants DER, so the raw point is rebuilt
    // into a full SPKI structure first.
    const template = generateKeyPairSync('ec', { namedCurve: 'P-256' }).publicKey.export({ type: 'spki', format: 'der' }) as Buffer;
    const rebuilt = createPublicKey({
      key: Buffer.concat([template.subarray(0, template.length - 65), Buffer.from(k.publicKey, 'base64url')]),
      format: 'der',
      type: 'spki',
    });
    const store: WebPushKeyStore = {
      keys: async () => k,
      subsForUser: async () => [],
      subsForContact: async () => [],
      forget: async () => {},
    };
    const sender = new WebPushSender(store, 'mailto:x@sentri.example', fetch, () => 1_000_000);
    const token = (sender as unknown as { vapidToken(aud: string, privateKey: string): string }).vapidToken('https://push.example.com', k.privateKey);
    const [h, c, s] = token.split('.');
    expect(JSON.parse(Buffer.from(h!, 'base64url').toString())).toEqual({ alg: 'ES256', typ: 'JWT' });
    expect(JSON.parse(Buffer.from(c!, 'base64url').toString())).toEqual({ aud: 'https://push.example.com', sub: 'mailto:x@sentri.example', exp: 1000 + 43_200 });
    expect(createVerify('SHA256').update(`${h}.${c}`).verify(rebuilt, rawToDer(Buffer.from(s!, 'base64url')))).toBe(true);
  });
});

describe('encryptAes128Gcm', () => {
  it('round-trips through the browser-side decryption', () => {
    const b = browserKeys();
    const body = encryptAes128Gcm({ p256dh: b.p256dh, auth: b.auth }, '{"kind":"sos","text":"help"}', Buffer.alloc(16, 7));
    expect(decryptBody(body, b.ecdh, b.auth)).toBe('{"kind":"sos","text":"help"}');
  });

  it('refuses a malformed p256dh key', () => {
    expect(() => encryptAes128Gcm({ p256dh: Buffer.alloc(10).toString('base64url'), auth: 'aaaa' }, 'x')).toThrow('bad p256dh');
  });
});

describe('WebPushSender', () => {
  it('encrypts the payload for the subscription and signs the request with VAPID', async () => {
    const r = rig();
    expect(await r.sender.sendToUser('u1', { kind: 'sos', text: 'help', sosId: 's1', inboxId: 'i-1' })).toBe(true);
    expect(r.calls).toHaveLength(1);
    const c = r.calls[0];
    expect(c.url).toBe(r.sub.endpoint);
    const m = /^vapid t=([^.]+\.[^.]+\.[^,]+), k=(.+)$/.exec(c.headers.authorization);
    expect(m).toBeTruthy();
    // the t= token is a JWT whose ES256 signature the push service checks
    // against the k= key (our public point)
    const [h, cl] = m![1].split('.');
    expect(JSON.parse(Buffer.from(h!, 'base64url').toString())).toEqual({ alg: 'ES256', typ: 'JWT' });
    const claim = JSON.parse(Buffer.from(cl!, 'base64url').toString()) as { aud: string; sub: string; exp: number };
    expect(claim.aud).toBe('https://push.example.com');
    expect(claim.sub).toBe('mailto:test@sentri.example');
    expect(claim.exp).toBe(1000 + 43_200); // seconds from the injected clock
    // the body decrypts to the same data shape FCM carries
    expect(decryptBody(c.body, r.browser.ecdh, r.browser.auth)).toBe('{"kind":"sos","text":"help","sosId":"s1","inboxId":"i-1"}');
    // an emergency asks the push service for high urgency and a long TTL
    expect(c.headers.urgency).toBe('high');
    expect(c.headers.ttl).toBe('604800');
    expect(c.headers['content-encoding']).toBe('aes128gcm');
  });

  it('keeps the end-of-alert copy alive as long as the alert so it can silence a queued ring', async () => {
    const r = rig();
    await r.sender.sendToUser('u1', { kind: 'clear', text: 'answered', sosId: 's1' });
    expect(r.calls[0].headers.urgency).toBe('normal');
    expect(r.calls[0].headers.ttl).toBe('604800');
    expect(decryptBody(r.calls[0].body, r.browser.ecdh, r.browser.auth)).toBe('{"kind":"clear","text":"answered","sosId":"s1"}');
  });

  it('returns false when the person has no subscriptions', async () => {
    const r = rig();
    expect(await r.sender.sendToContact('none', { kind: 'sos', text: 'x' })).toBe(false);
    expect(r.calls).toHaveLength(0);
  });

  it('forgets subscriptions the push service says are gone', async () => {
    const r404 = rig({ status: 404 });
    expect(await r404.sender.sendToUser('u1', { kind: 'sos', text: 'x' })).toBe(false);
    expect(r404.forgotten).toEqual(['w1']);
    const r410 = rig({ status: 410 });
    expect(await r410.sender.sendToUser('u1', { kind: 'sos', text: 'x' })).toBe(false);
    expect(r410.forgotten).toEqual(['w1']);
  });

  it('keeps the subscription on a server error and reports failure without throwing', async () => {
    const r = rig({ status: 503 });
    expect(await r.sender.sendToUser('u1', { kind: 'sos', text: 'x' })).toBe(false);
    expect(r.forgotten).toEqual([]);
  });
});

describe('FanoutPushSender', () => {
  const ok = (v: boolean): PushSender => ({
    sendToContact: async () => v,
    sendToUser: async () => v,
  });
  const boom: PushSender = {
    sendToContact: async () => {
      throw new Error('x');
    },
    sendToUser: async () => {
      throw new Error('x');
    },
  };

  it('succeeds when any one channel reaches the person', async () => {
    expect(await new FanoutPushSender([ok(false), ok(true)]).sendToUser('u', { kind: 'sos', text: 'x' })).toBe(true);
    expect(await new FanoutPushSender([ok(false), ok(false)]).sendToUser('u', { kind: 'sos', text: 'x' })).toBe(false);
    // a channel error is a miss, not a crash: the other channel still counts
    expect(await new FanoutPushSender([boom, ok(true)]).sendToContact('c', { kind: 'sos', text: 'x' })).toBe(true);
  });
});
