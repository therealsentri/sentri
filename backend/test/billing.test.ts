import { createHmac } from 'node:crypto';
import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { isPremium, MemoryBillingStore, PAYSTACK_PLANS, registerBillingRoutes } from '../src/modules/billing/billing.js';

function rig() {
  const app = Fastify();
  const store = new MemoryBillingStore();
  registerBillingRoutes(app, { store, authenticate: async (req) => (req.headers['x-dev-user'] === 'u1' ? 'u1' : null) });
  return { app, store };
}

const webhook = (body: unknown, secret: string) => ({
  method: 'POST' as const,
  url: '/v1/billing/paystack/webhook',
  headers: {
    'content-type': 'application/json',
    'x-paystack-signature': createHmac('sha512', secret).update(JSON.stringify(body)).digest('hex'),
  },
  payload: JSON.stringify(body),
});

describe('billing routes', () => {
  it('a paid plan stays premium; trial expires after 14 days', async () => {
    const future = new Date(Date.now() + 86_400_000).toISOString();
    const past = new Date(Date.now() - 86_400_000).toISOString();
    expect(isPremium({ plan: 'monthly', expiresAt: future, trialEndsAt: past })).toBe(true);
    expect(isPremium({ plan: 'free', expiresAt: null, trialEndsAt: future })).toBe(true);
    expect(isPremium({ plan: 'free', expiresAt: null, trialEndsAt: past })).toBe(false);
  });

  it('publishes both rails and keeps status private', async () => {
    const { app } = rig();
    const plans = await app.inject({ method: 'GET', url: '/v1/billing/plans' });
    expect(plans.statusCode).toBe(200);
    expect(plans.json().naira).toHaveLength(3);
    expect(plans.json().international[0].currency).toBe('USD');
    const anon = await app.inject({ method: 'GET', url: '/v1/billing/status' });
    expect(anon.statusCode).toBe(401);

    const mine = await app.inject({ method: 'GET', url: '/v1/billing/status', headers: { 'x-dev-user': 'u1' } });
    expect(mine.json().plan).toBe('free');
    expect(mine.json().premium).toBe(true); // 14-day trial is running
    expect(mine.json().trialEndsAt).toBeTruthy();
  });

  it('rejects a forged Paystack webhook', async () => {
    const { app, store } = rig();
    const res = await app.inject({ ...webhook({ event: 'charge.success' }, 'wrong-key'), headers: { 'content-type': 'application/json', 'x-paystack-signature': 'deadbeef' } });
    expect(res.statusCode).toBe(401);
    expect((await store.status('u1')).plan).toBe('free');
  });

  it('activates a verified payment once, and ignores a replay', async () => {
    const { app, store } = rig();
    const secret = 'sk_test_local';
    process.env.PAYSTACK_SECRET_KEY = secret;
    const body = {
      event: 'charge.success',
      data: {
        reference: 'ref-1', status: 'success', amount: PAYSTACK_PLANS.monthly.amount, currency: 'NGN',
        metadata: { uid: 'u1', plan: 'monthly' },
      },
    };
    const first = await app.inject(webhook(body, secret));
    expect(first.statusCode).toBe(200);
    expect(first.json()).toEqual({ received: true, activated: true });
    expect((await store.status('u1')).plan).toBe('monthly');
    const replay = await app.inject(webhook(body, secret));
    expect(replay.json().activated).toBe(false);
    delete process.env.PAYSTACK_SECRET_KEY;
  });

  it('refuses a payment whose amount does not match the plan', async () => {
    const { app } = rig();
    const secret = 'sk_test_local';
    process.env.PAYSTACK_SECRET_KEY = secret;
    const body = { event: 'charge.success', data: { reference: 'ref-2', status: 'success', amount: 1, currency: 'NGN', metadata: { uid: 'u1', plan: 'monthly' } } };
    const res = await app.inject(webhook(body, secret));
    expect(res.statusCode).toBe(400);
    delete process.env.PAYSTACK_SECRET_KEY;
  });
});
