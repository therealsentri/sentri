import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { FixedWindowLimiter } from '../../lib/rate-limit.js';
import type { PgWebPushStore } from './pg-webpush.js';

export interface WebPushRouteDeps {
  store: PgWebPushStore;
  authenticate: (req: FastifyRequest) => Promise<string | null>;
  limiter: FixedWindowLimiter;
}

const Subscribe = z.object({
  endpoint: z.string().url().max(1024),
  keys: z.object({ p256dh: z.string().min(40).max(200), auth: z.string().min(10).max(200) }),
});

/**
 * The website's push plumbing. The browser asks for the server's VAPID public
 * key (GET), subscribes itself with the Push API, and hands us the
 * subscription (POST). Unauthenticated GET is fine: a public key is public by
 * design, and the site needs it before a person is signed in.
 */
export function registerWebPushRoutes(app: FastifyInstance, d: WebPushRouteDeps): void {
  app.get('/v1/webpush/public-key', async (_req, reply) => {
    return reply.send({ publicKey: (await d.store.keys()).publicKey });
  });

  app.post('/v1/me/webpush', async (req, reply) => {
    const uid = await d.authenticate(req);
    if (!uid) return reply.code(401).send({ error: 'unauthorized' });
    if (!d.limiter.allow(`webpush:${uid}`)) return reply.code(429).send({ error: 'rate_limited' });
    const b = Subscribe.parse(req.body);
    // An endpoint is per-browser: re-subscribing with fresh keys refreshes the
    // stored copy, and moving accounts keeps the (endpoint -> person) link true.
    await d.store.add(uid, { endpoint: b.endpoint, p256dh: b.keys.p256dh, auth: b.keys.auth });
    return reply.code(204).send();
  });
}
