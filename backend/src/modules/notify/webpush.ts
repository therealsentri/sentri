import { createCipheriv, createECDH, createSign, generateKeyPairSync, hkdfSync, randomBytes } from 'node:crypto';
import type { Logger } from '../../domain/types.js';
import { noopLogger } from '../../domain/types.js';
import type { PushPayload, PushSender } from './contact-notifier.js';

/**
 * Web Push: the free alert channel for iPhones (and any browser).
 *
 * The Sentri website, installed to the home screen (PWA), subscribes with the
 * browser's Push API; this sender then posts RFC 8291 `aes128gcm` payloads to
 * the subscription's endpoint. On iOS 16.4+ Safari delivers those through
 * APNs as real notifications - lock screen, watch, the works - and Apple
 * documents that this needs no Apple Developer Program at all. That is why
 * this file exists alongside fcm.ts: the native Android app rides FCM, the
 * website rides Web Push, and every contact is reached by one of the two.
 *
 * No npm dependency: VAPID is an ES256 JWT and the payload is AES-128-GCM
 * over ECDH(P-256) - all of it is in node:crypto.
 */

export interface VapidKeys {
  /** base64url of the raw 65-byte uncompressed P-256 point. */
  publicKey: string;
  /** PKCS8 PEM of the private scalar. Lives in Postgres (webpush_keys). */
  privateKey: string;
}

export interface WebPushSub {
  id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
}

/** Where subscriptions and the VAPID keypair live. Postgres: pg-webpush.ts. */
export interface WebPushKeyStore {
  keys(): Promise<VapidKeys>;
  subsForUser(userId: string): Promise<WebPushSub[]>;
  /** A contact who subscribed on the website, found through their phone number. */
  subsForContact(contactId: string): Promise<WebPushSub[]>;
  /** Called when the push service says the subscription is gone (404/410). */
  forget(id: string): Promise<void>;
}

export function generateVapidKeys(): VapidKeys {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const spki = publicKey.export({ type: 'spki', format: 'der' }) as Buffer;
  return {
    // The raw uncompressed point is what PushSubscription.exportKey() hands
    // out and what push services compare against - the tail of the SPKI DER.
    publicKey: spki.subarray(spki.length - 65).toString('base64url'),
    privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  };
}

/** DER ECDSA signature (0x30 ... 0x02 r 0x02 s) -> the raw 64-byte r||s JWT wants. */
function derToRaw(sig: Buffer): Buffer {
  let p = 2;
  if (sig[1] & 0x80) p += sig[1] & 0x7f; // skip extra length bytes, land on the first 0x02
  // One DER INTEGER each for r and s. A length of 33 means a leading sign
  // byte (0x00) the raw form must not carry; drop it, then pad left to 32.
  const derInt = (sig: Buffer, at: number): Buffer => {
    const len = sig[at + 1];
    const v = sig.subarray(at + 2, at + 2 + len);
    return v.length > 32 ? v.subarray(v.length - 32) : v;
  };
  const r = derInt(sig, p);
  const s = derInt(sig, p + 2 + sig[p + 1]);
  const out = Buffer.alloc(64);
  r.copy(out, 32 - r.length);
  s.copy(out, 64 - s.length);
  return out;
}

/**
 * RFC 8291 message encryption with the aes128gcm content coding.
 * A fresh ephemeral ECDH key is mixed with the subscription's keys, so the
 * payload can only be read by that one browser session. Returns the full
 * request body: header (salt | rs=4096 | key length | server public key) plus
 * the ciphertext. `salt` is injectable so tests can round-trip deterministically.
 */
export function encryptAes128Gcm(sub: { p256dh: string; auth: string }, payload: string, salt?: Buffer): Buffer {
  const uaPub = Buffer.from(sub.p256dh, 'base64url');
  if (uaPub.length !== 65 || uaPub[0] !== 4) throw new Error('bad p256dh key');
  const authSecret = Buffer.from(sub.auth, 'base64url');
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  const asPub = ecdh.getPublicKey();
  // RFC 8291 4.2: IKM = concat(ecdh_secret, auth_secret), then the info block
  // binds both public keys in, so a ciphertext cannot be re-targeted.
  const salt16 = salt ?? randomBytes(16);
  const prk = Buffer.from(
    hkdfSync('sha256', Buffer.concat([ecdh.computeSecret(uaPub), authSecret]), salt16, Buffer.concat([Buffer.from('WebPush: info\0'), uaPub, asPub]), 32),
  );
  const cek = Buffer.from(hkdfSync('sha256', prk, salt16, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(hkdfSync('sha256', prk, salt16, Buffer.from('Content-Encoding: nonce\0'), 12));
  // RFC 8188: at least one zero padding byte, then the 0x02 delimiter.
  const plaintext = Buffer.concat([Buffer.from(payload, 'utf8'), Buffer.from([0x00, 0x02])]);
  const cipher = createCipheriv('aes-128-gcm', cek, nonce);
  const body = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
  const header = Buffer.concat([salt16, Buffer.from([0, 0, 16, 0]), Buffer.from([asPub.length]), asPub]);
  return Buffer.concat([header, body]);
}

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');

/**
 * Sends an emergency to every Web Push subscription a person (or contact) has
 * made on the website. The same payload shape FCM carries, minus the Android
 * tray fields: the service worker on the phone IS the notification, and Safari
 * revokes permission if a push ever arrives without one being shown, so the
 * worker always shows what we send.
 */
export class WebPushSender implements PushSender {
  private cachedKeys: { keys: VapidKeys; until: number } | undefined;

  constructor(
    private readonly store: WebPushKeyStore,
    /** VAPID `sub`: a contact address push services can reach. */
    private readonly subject: string,
    private readonly fetchFn: typeof fetch = fetch,
    private readonly clock: () => number = Date.now,
    private readonly log: Logger = noopLogger,
  ) {}

  private async keys(): Promise<VapidKeys> {
    const now = this.clock();
    if (this.cachedKeys && this.cachedKeys.until > now) return this.cachedKeys.keys;
    const keys = await this.store.keys();
    this.cachedKeys = { keys, until: now + 5 * 60_000 };
    return keys;
  }

  /** A VAPID token: an ES256 JWT the push service checks against `k=` (the public key). */
  private vapidToken(aud: string, privateKey: string): string {
    const now = Math.floor(this.clock() / 1000);
    const head = b64({ alg: 'ES256', typ: 'JWT' });
    const claims = b64({ aud, sub: this.subject, exp: now + 43_200 });
    const der = createSign('SHA256').update(`${head}.${claims}`).sign(privateKey);
    return `${head}.${claims}.${derToRaw(der).toString('base64url')}`;
  }

  private async sendOne(sub: WebPushSub, p: PushPayload): Promise<boolean> {
    const { publicKey, privateKey } = await this.keys();
    const data: Record<string, string> = { kind: p.kind, text: p.text };
    if (p.sosId) data.sosId = p.sosId;
    if (p.inboxId) data.inboxId = p.inboxId;
    // v50: web-push providers keep an undelivered message for the TTL. Seven days
    // means an iPhone (or Android browser) that was offline at alert time still
    // receives it on reconnect. Clear copies get the same TTL so they can still
    // stop the ring; the service worker's shared tag does the replacement.
    const urgent = p.kind === 'sos' || p.kind === 'duress' || p.kind === 'offline';
    const res = await this.fetchFn(sub.endpoint, {
      method: 'POST',
      headers: {
        authorization: `vapid t=${this.vapidToken(new URL(sub.endpoint).origin, privateKey)}, k=${publicKey}`,
        'content-encoding': 'aes128gcm',
        ttl: urgent || p.kind === 'clear' ? '604800' : '60',
        urgency: urgent ? 'high' : 'normal',
      },
      body: encryptAes128Gcm(sub, JSON.stringify(data)) as unknown as BodyInit,
      signal: AbortSignal.timeout(5000),
    });
    if (res.status === 200 || res.status === 201) return true;
    // 404/410: the subscription expired (Safari recycles endpoints) or was
    // revoked. Forget it so a live alert is not slowed by dead endpoints next time.
    if (res.status === 404 || res.status === 410) await this.store.forget(sub.id).catch(() => {});
    return false;
  }

  private async sendAll(list: WebPushSub[], p: PushPayload): Promise<boolean> {
    if (list.length === 0) return false;
    const results = await Promise.all(
      list.map((s) =>
        this.sendOne(s, p).catch((err) => {
          this.log.error({ err: err instanceof Error ? err.message : 'unknown' }, 'web push failed');
          return false;
        }),
      ),
    );
    return results.some(Boolean);
  }

  async sendToContact(contactId: string, p: PushPayload): Promise<boolean> {
    return this.sendAll(await this.store.subsForContact(contactId), p);
  }

  async sendToUser(userId: string, p: PushPayload): Promise<boolean> {
    return this.sendAll(await this.store.subsForUser(userId), p);
  }
}

/**
 * Delivers through every registered channel (FCM for the app, Web Push for the
 * website) and reports success if ANY one of them reached the person. A
 * contact who only has the app, or only the site, is equally alerted.
 */
export class FanoutPushSender implements PushSender {
  constructor(private readonly senders: PushSender[]) {}

  private async fanout(run: (s: PushSender) => Promise<boolean>): Promise<boolean> {
    const results = await Promise.all(this.senders.map((s) => run(s).catch(() => false)));
    return results.some(Boolean);
  }

  async sendToContact(contactId: string, p: PushPayload): Promise<boolean> {
    return this.fanout((s) => s.sendToContact(contactId, p));
  }

  async sendToUser(userId: string, p: PushPayload): Promise<boolean> {
    return this.fanout((s) => s.sendToUser(userId, p));
  }
}
