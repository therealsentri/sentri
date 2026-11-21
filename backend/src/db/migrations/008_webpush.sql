-- v48: Web Push for the Sentri website (PWA).
-- A phone that installs the site to its home screen (iOS 16.4+ or any modern
-- browser) can receive emergency alerts as real push notifications, with no
-- Apple Developer account and no expiry date. Apple itself documents that web
-- push needs no paid program membership; the browser (Safari on iOS routes it
-- through APNs) shows the notification even when the site is not open.
--
-- webpush_keys holds THE ONE VAPID keypair the server signs pushes with. It is
-- generated on first boot and stored here, so a fresh deployment works with
-- zero configuration: no env vars, no console clicks. If the row is lost, a
-- new one is created - old subscriptions simply fail once and are forgotten.
CREATE TABLE webpush_keys (
  id          INTEGER PRIMARY KEY CHECK (id = 1),
  public_key  TEXT NOT NULL,
  private_key TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One row per browser subscription. The endpoint is the push service's unique
-- mailbox URL; p256dh and auth are the browser's ECDH keys, which we encrypt at
-- rest exactly like FCM device tokens (same FieldCrypto). A subscription is
-- per-browser, not per-device: several people can share a phone's browser and
-- each signs in with their own account, so the (endpoint -> user) link is kept
-- up to date on every re-subscribe (ON CONFLICT DO UPDATE in code).
CREATE TABLE webpush_subs (
  id          UUID PRIMARY KEY,
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint    TEXT NOT NULL UNIQUE,
  p256dh_enc  BYTEA NOT NULL,
  auth_enc    BYTEA NOT NULL,
  created_at  BIGINT NOT NULL
);
CREATE INDEX webpush_subs_user_idx ON webpush_subs(user_id);
