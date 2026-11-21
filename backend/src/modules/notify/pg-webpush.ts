import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { FieldCrypto } from '../../lib/field-crypto.js';
import { generateVapidKeys, type VapidKeys, type WebPushKeyStore, type WebPushSub } from './webpush.js';

/**
 * Postgres home of Web Push subscriptions (the website's alert receivers) and
 * THE VAPID keypair the server signs every push with. The keypair row is
 * created on first boot, so a fresh deployment needs zero configuration.
 */
export class PgWebPushStore implements WebPushKeyStore {
  private cachedKeys: VapidKeys | undefined;

  constructor(
    private readonly pool: Pool,
    private readonly fc: FieldCrypto,
  ) {}

  async keys(): Promise<VapidKeys> {
    if (this.cachedKeys) return this.cachedKeys;
    const r = await this.pool.query<{ public_key: string; private_key: string }>('SELECT public_key, private_key FROM webpush_keys WHERE id = 1');
    if (r.rows.length === 0) {
      // First boot (or a wiped table): make a keypair and store it. If two
      // replicas race, the loser re-reads the winner's row below - one keypair
      // survives either way, which is what matters.
      const fresh = generateVapidKeys();
      await this.pool.query('INSERT INTO webpush_keys (id, public_key, private_key) VALUES (1, $1, $2) ON CONFLICT (id) DO NOTHING', [
        fresh.publicKey,
        fresh.privateKey,
      ]);
    }
    const row = (await this.pool.query<{ public_key: string; private_key: string }>('SELECT public_key, private_key FROM webpush_keys WHERE id = 1')).rows[0];
    this.cachedKeys = { publicKey: row.public_key, privateKey: row.private_key };
    return this.cachedKeys;
  }

  /** Called by the website subscribe route. Re-subscribing the same browser refreshes its keys. */
  async add(userId: string, s: { endpoint: string; p256dh: string; auth: string }): Promise<void> {
    await this.pool.query(
      `INSERT INTO webpush_subs (id, user_id, endpoint, p256dh_enc, auth_enc, created_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (endpoint) DO UPDATE SET user_id = EXCLUDED.user_id, p256dh_enc = EXCLUDED.p256dh_enc, auth_enc = EXCLUDED.auth_enc`,
      [randomUUID(), userId, s.endpoint, this.fc.encrypt(s.p256dh), this.fc.encrypt(s.auth), Date.now()],
    );
  }

  private decrypt(rows: { id: string; endpoint: string; p256dh_enc: Buffer; auth_enc: Buffer }[]): WebPushSub[] {
    return rows.flatMap((r) => {
      try {
        return [{ id: r.id, endpoint: r.endpoint, p256dh: this.fc.decrypt(r.p256dh_enc), auth: this.fc.decrypt(r.auth_enc) }];
      } catch {
        return []; // unreadable keys (DATA_KEY rotated): skip rather than fail the alert
      }
    });
  }

  async subsForUser(userId: string): Promise<WebPushSub[]> {
    const r = await this.pool.query<{ id: string; endpoint: string; p256dh_enc: Buffer; auth_enc: Buffer }>(
      'SELECT id, endpoint, p256dh_enc, auth_enc FROM webpush_subs WHERE user_id = $1',
      [userId],
    );
    return this.decrypt(r.rows);
  }

  async subsForContact(contactId: string): Promise<WebPushSub[]> {
    // The contact's phone blind index equals a user's blind index when that
    // person signed up on the website too - same join the FCM token store uses.
    const r = await this.pool.query<{ id: string; endpoint: string; p256dh_enc: Buffer; auth_enc: Buffer }>(
      `SELECT w.id, w.endpoint, w.p256dh_enc, w.auth_enc
         FROM contacts c
         JOIN users u ON u.phone_hmac = c.phone_hmac AND u.deleted_at IS NULL
         JOIN webpush_subs w ON w.user_id = u.id
        WHERE c.id = $1`,
      [contactId],
    );
    return this.decrypt(r.rows);
  }

  async forget(id: string): Promise<void> {
    await this.pool.query('DELETE FROM webpush_subs WHERE id = $1', [id]);
  }
}
