import { createSign } from 'node:crypto';
import type { Logger } from '../../domain/types.js';
import { noopLogger } from '../../domain/types.js';
import type { PushPayload, PushSender } from './contact-notifier.js';

/** Where device push tokens live. Postgres implementation: pg-push-tokens.ts. */
export interface PushTokenStore {
  tokensForUser(userId: string): Promise<{ deviceId: string; token: string }[]>;
  /** A contact who also has the app: their own devices, found through their phone number. */
  tokensForContact(contactId: string): Promise<{ deviceId: string; token: string }[]>;
  /** Called when FCM says a token is no longer valid. */
  forgetToken(deviceId: string): Promise<void>;
}

export interface ServiceAccount {
  project_id: string;
  client_email: string;
  private_key: string;
}

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');

/**
 * Firebase Cloud Messaging (HTTP v1) sender. No SDK: a signed JWT is exchanged for a short-lived
 * access token, which is cached until shortly before it expires.
 *
 * v46: emergency-class messages carry a notification copy ALONGSIDE the data. Why: the data-only
 * message used to be the whole delivery, which meant the contact's phone had to boot the app's
 * background Dart isolate before anything rang - 5-10 seconds late, and on some phones nothing at
 * all unless the app happened to be open. The notification copy is shown by Android itself, with
 * no app code involved, so the alert lands in about a second, app closed or not - like any other
 * messaging app. The data payload still rides along (the running app shows its own richer alert,
 * and the inbox keeps working); a `tray: '1'` marker tells a living background handler that the
 * system already showed the message, so it does not post a second one.
 *
 * The "clear" message also carries a notification copy - on a QUIET channel, with the same tag as
 * the alert. Android replaces the ringing notification with the quiet one, so the alarm stops the
 * moment someone responds or the alert is cancelled, even on a phone where the app is not open.
 *
 * v47: the iPhone mirror of the same design. APNs - not Dart - is what shows a notification on
 * iOS, so the emergency classes now carry an apns alert (title, body, sound, time-sensitive) and
 * the clear copy shares the alert's apns-collapse-id, which is how iOS replaces the ringing
 * notification and stops the sound. Android and iPhone contacts alert each other through the
 * exact same payload path, only the platform block differs.
 */
export class FcmPushSender implements PushSender {
  private access: { token: string; expiresAt: number } | undefined;
  /** One token exchange at a time: several devices sending at once share it. */
  private fetching: Promise<string> | undefined;

  constructor(
    private readonly tokens: PushTokenStore,
    private readonly account: ServiceAccount,
    private readonly fetchFn: typeof fetch = fetch,
    private readonly clock: () => number = Date.now,
    private readonly log: Logger = noopLogger,
  ) {}

  private accessToken(): Promise<string> {
    const now = this.clock();
    if (this.access && this.access.expiresAt - 60_000 > now) return Promise.resolve(this.access.token);
    this.fetching ??= this.exchange().finally(() => {
      this.fetching = undefined;
    });
    return this.fetching;
  }

  private async exchange(): Promise<string> {
    const now = this.clock();
    const iat = Math.floor(now / 1000);
    const claim = {
      iss: this.account.client_email,
      scope: 'https://www.googleapis.com/auth/firebase.messaging',
      aud: 'https://oauth2.googleapis.com/token',
      iat,
      exp: iat + 3600,
    };
    const unsigned = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64(claim)}`;
    const sig = createSign('RSA-SHA256').update(unsigned).sign(this.account.private_key).toString('base64url');
    const res = await this.fetchFn('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${unsigned}.${sig}` }),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) throw new Error(`fcm auth ${res.status}`);
    const j = (await res.json()) as { access_token: string; expires_in: number };
    this.access = { token: j.access_token, expiresAt: now + j.expires_in * 1000 };
    return j.access_token;
  }

  private async sendOne(deviceId: string, token: string, p: PushPayload): Promise<boolean> {
    const bearer = await this.accessToken();
    // v50: FCM/APNs store-and-forward for a phone that is OFFLINE when the alert
    // is sent. It lands when the phone reconnects (within 7 days) instead of
    // expiring after 30 minutes. The "clear" copy keeps the SAME collapse key and
    // the same long TTL so it still replaces a queued alert for a finished event.
    const ttl = p.kind === 'sos' || p.kind === 'duress' || p.kind === 'offline' || p.kind === 'clear' ? 604800 : 60;
    const data: Record<string, string> = { kind: p.kind, text: p.text };
    if (p.sosId) data.sosId = p.sosId;
    if (p.inboxId) data.inboxId = p.inboxId;
    // v46: the notification copy. The tag is what Android uses to REPLACE a previous
    // notification: every repeat round of a live alert replaces the last one (and rings
    // again), and the quiet "clear" copy replaces the ringing one to stop the alarm.
    // The channel must already exist on the phone - the app creates 'sentri_alerts' and
    // 'sentri_quiet' whenever it runs, and a device that has a push token has run at
    // least once - so the alert plays at ALARM volume, like an alarm clock.
    const urgent = p.kind === 'sos' || p.kind === 'duress' || p.kind === 'offline';
    const tray = urgent || p.kind === 'clear';
    const tag = p.inboxId ?? p.sosId ?? undefined;
    const android: Record<string, unknown> = { priority: 'HIGH', ttl: `${ttl}s`, ...(p.sosId ? { collapse_key: p.sosId } : {}) };
    if (tray) {
      if (data.tray === undefined) data.tray = '1';
      android.notification = {
        title: 'Sentri',
        body: p.text,
        // Emergency classes ring on the alarm channel; the stop-the-ring copy is silent.
        channel_id: urgent ? 'sentri_alerts' : 'sentri_quiet',
        ...(tag ? { tag } : {}),
      };
    }
    // v47: the same instant-delivery copy for iPhones. APNs is what actually shows a
    // notification on iOS - a data-only message just wakes the app's Dart isolate
    // (seconds late, nothing at all if the app is closed), so the emergency classes
    // carry a real alert here too: title + body + sound, marked time-sensitive so it
    // breaks through Focus. The clear copy rides the same apns-collapse-id as the
    // alert, which is how iOS replaces (and thereby silences) the ringing one - the
    // iOS mirror of Android's same-tag quiet-channel replacement. Everything else
    // stays content-available only, like before.
    const aps: Record<string, unknown> = { 'content-available': 1 };
    if (tray) {
      aps.alert = { title: 'Sentri', body: p.text };
      if (urgent) {
        aps.sound = 'default';
        aps['interruption-level'] = 'time-sensitive';
      } else {
        aps['interruption-level'] = 'passive';
      }
    }
    const res = await this.fetchFn(`https://fcm.googleapis.com/v1/projects/${this.account.project_id}/messages:send`, {
      method: 'POST',
      headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        message: {
          token,
          data,
          android,
          apns: { headers: { 'apns-priority': '10', 'apns-expiration': String(Math.floor(this.clock() / 1000) + ttl), ...(p.sosId ? { 'apns-collapse-id': p.sosId.slice(0, 64) } : {}) }, payload: { aps } },
        },
      }),
      signal: AbortSignal.timeout(5000),
    });
    if (res.ok) return true;
    if (res.status === 404 || res.status === 400) {
      // UNREGISTERED / INVALID_ARGUMENT: the app was removed or the token is stale.
      const body = (await res.json().catch(() => ({}))) as { error?: { status?: string } };
      if (body.error?.status === 'NOT_FOUND' || body.error?.status === 'UNREGISTERED' || body.error?.status === 'INVALID_ARGUMENT') {
        await this.tokens.forgetToken(deviceId).catch(() => {});
      }
    }
    if (res.status === 401) this.access = undefined; // token revoked: fetch a new one next time
    return false;
  }

  private async sendAll(list: { deviceId: string; token: string }[], p: PushPayload): Promise<boolean> {
    if (list.length === 0) return false;
    const results = await Promise.all(
      list.map((t) =>
        this.sendOne(t.deviceId, t.token, p).catch((err) => {
          this.log.error({ err: err instanceof Error ? err.message : 'unknown' }, 'push failed');
          return false;
        }),
      ),
    );
    return results.some(Boolean);
  }

  async sendToContact(contactId: string, p: PushPayload): Promise<boolean> {
    return this.sendAll(await this.tokens.tokensForContact(contactId), p);
  }

  async sendToUser(userId: string, p: PushPayload): Promise<boolean> {
    return this.sendAll(await this.tokens.tokensForUser(userId), p);
  }
}
