import { createHmac, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';

export interface BillingStatus { plan: string; expiresAt: string | null }

export interface BillingStore {
  status(uid: string): Promise<BillingStatus>;
  /** Returns false when the reference was already used (idempotent webhook). */
  activate(uid: string, plan: string, days: number, reference: string, amount: number, currency: string): Promise<boolean>;
}

export class PgBillingStore implements BillingStore {
  constructor(private readonly pool: Pool) {}
  async status(uid: string): Promise<BillingStatus> {
    const r = await this.pool.query('SELECT plan, plan_expires_at AS "expiresAt" FROM users WHERE id=$1', [uid]);
    const row = r.rows[0] as { plan?: string; expiresAt?: Date | string | null } | undefined;
    return { plan: row?.plan ?? 'free', expiresAt: row?.expiresAt ? String(row.expiresAt) : null };
  }
  async activate(uid: string, plan: string, days: number, reference: string, amount: number, currency: string): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const ins = await client.query(
        'INSERT INTO billing_events(reference,user_id,plan,amount,currency) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING',
        [reference, uid, plan, amount, currency],
      );
      if ((ins.rowCount ?? 0) === 0) { await client.query('ROLLBACK'); return false; }
      await client.query(
        'UPDATE users SET plan=$2, plan_expires_at=now() + ($3 || \' days\')::interval WHERE id=$1',
        [uid, plan, days],
      );
      await client.query('COMMIT');
      return true;
    } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
  }
}

export class MemoryBillingStore implements BillingStore {
  private readonly plans = new Map<string, BillingStatus>();
  private readonly seen = new Set<string>();
  async status(uid: string): Promise<BillingStatus> { return this.plans.get(uid) ?? { plan: 'free', expiresAt: null }; }
  async activate(uid: string, plan: string, days: number, reference: string, amount: number, currency: string): Promise<boolean> {
    if (this.seen.has(reference)) return false;
    this.seen.add(reference);
    this.plans.set(uid, { plan, expiresAt: new Date(Date.now() + days * 86_400_000).toISOString() });
    return true;
  }
}

export const PAYSTACK_PLANS = {
  monthly: { amount: 120000, currency: 'NGN', days: 30, label: 'Premium monthly' },
  yearly: { amount: 1200000, currency: 'NGN', days: 365, label: 'Premium yearly' },
  family: { amount: 2000000, currency: 'NGN', days: 365, label: 'Family yearly' },
} as const;
export const CREEM_PRODUCT_ID = 'prod_7adtLy61uwXBpangAlJzsG';

interface Deps {
  store: BillingStore;
  authenticate: (req: FastifyRequest) => Promise<string | null>;
  fetchFn?: typeof fetch;
  clock?: () => number;
  log?: { warn: (o: Record<string, unknown>, m?: string) => void };
}

function sigOk(expected: string, got: string | undefined): boolean {
  if (!got || !expected) return false;
  const a = Buffer.from(expected); const b = Buffer.from(got);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function registerBillingRoutes(app: FastifyInstance, deps: Deps): FastifyInstance {
  const fetchFn = deps.fetchFn ?? fetch;
  // Encapsulated: this parser only affects the billing routes, and gives us the
  // exact bytes Paystack/Creem signed. JSON parsing stays identical.
  return app.register(async (child) => {
    child.addContentTypeParser('application/json', { parseAs: 'buffer' }, (req, body, done) => {
      (req as FastifyRequest & { rawBody?: Buffer }).rawBody = Buffer.from(body as Buffer);
      try { done(null, JSON.parse((body as Buffer).toString('utf8'))); } catch (e) { done(e as Error, undefined); }
    });

    child.get('/v1/billing/plans', async () => ({
      naira: [
        { id: 'monthly', amount: 120000, currency: 'NGN', label: 'Premium monthly' },
        { id: 'yearly', amount: 1200000, currency: 'NGN', label: 'Premium yearly' },
        { id: 'family', amount: 2000000, currency: 'NGN', label: 'Family yearly' },
      ],
      international: [{ id: 'monthly', amount: 299, currency: 'USD', label: 'Premium monthly' }],
    }));

    child.get('/v1/billing/status', async (req, reply) => {
      const uid = await deps.authenticate(req);
      if (!uid) return reply.code(401).send({ error: 'unauthorized' });
      return deps.store.status(uid);
    });

    child.post('/v1/billing/checkout', async (req, reply) => {
      const uid = await deps.authenticate(req);
      if (!uid) return reply.code(401).send({ error: 'unauthorized' });
      const b = (req.body ?? {}) as { rail?: string; plan?: string };
      const rail = b.rail === 'creem' ? 'creem' : 'paystack';
      const plan = b.plan && b.plan in PAYSTACK_PLANS ? b.plan as keyof typeof PAYSTACK_PLANS : 'monthly';
      if (rail === 'paystack') {
        const secret = process.env.PAYSTACK_SECRET_KEY;
        if (!secret) return reply.code(503).send({ error: 'payments_not_configured' });
        const res = await fetchFn('https://api.paystack.co/transaction/initialize', {
          method: 'POST',
          headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' },
          body: JSON.stringify({
            email: (req.body as { email?: string }).email || 'buyer@sentri.com.ng',
            amount: PAYSTACK_PLANS[plan].amount,
            currency: 'NGN',
            callback_url: `${process.env.PUBLIC_BASE_URL ?? 'https://sentri-api.onrender.com'}/v1/billing/callback`,
            metadata: { uid, plan },
          }),
          signal: AbortSignal.timeout(8000),
        });
        if (!res.ok) return reply.code(502).send({ error: 'checkout_failed' });
        const j = await res.json() as { data?: { authorization_url?: string; reference?: string } };
        return { url: j.data?.authorization_url, reference: j.data?.reference, rail, plan };
      }
      const key = process.env.CREEM_API_KEY;
      if (!key) return reply.code(503).send({ error: 'payments_not_configured' });
      const res = await fetchFn('https://api.creem.io/v1/checkouts', {
        method: 'POST',
        headers: { 'x-api-key': key, 'content-type': 'application/json' },
        body: JSON.stringify({
          product_id: CREEM_PRODUCT_ID,
          customer_email: (req.body as { email?: string }).email || 'buyer@sentri.com.ng',
          success_url: 'https://sentri.com.ng/?premium=1',
          metadata: { uid, plan },
        }),
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) return reply.code(502).send({ error: 'checkout_failed' });
      const j = await res.json() as { checkout_url?: string; url?: string };
      return { url: j.checkout_url ?? j.url, rail, plan };
    });

    child.get('/v1/billing/callback', async (req, reply) => {
      const q = (req.query ?? {}) as { reference?: string };
      const reference = q.reference ?? '';
      const secret = process.env.PAYSTACK_SECRET_KEY;
      if (reference && secret) {
        try {
          const res = await fetchFn(`https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`, {
            headers: { authorization: `Bearer ${secret}` }, signal: AbortSignal.timeout(8000),
          });
          if (res.ok) {
            const j = await res.json() as { data?: { status?: string; metadata?: { uid?: string; plan?: string }; amount?: number; currency?: string } };
            const d = j.data;
            if (d?.status === 'success' && d.metadata?.uid && d.metadata.plan && d.metadata.plan in PAYSTACK_PLANS) {
              const p = PAYSTACK_PLANS[d.metadata.plan as keyof typeof PAYSTACK_PLANS];
              if (d.amount === p.amount && d.currency === p.currency) {
                await deps.store.activate(d.metadata.uid, d.metadata.plan, p.days, reference, d.amount, d.currency);
              }
            }
          }
        } catch (e) { deps.log?.warn({ err: e instanceof Error ? e.message : 'verify failed' }, 'billing callback'); }
      }
      return reply.redirect('https://sentri.com.ng/?premium=1');
    });

    child.post('/v1/billing/paystack/webhook', async (req, reply) => {
      const raw = (req as FastifyRequest & { rawBody?: Buffer }).rawBody ?? Buffer.from(JSON.stringify(req.body ?? {}));
      const secret = process.env.PAYSTACK_SECRET_KEY ?? '';
      const expected = createHmac('sha512', secret).update(raw).digest('hex');
      const got = req.headers['x-paystack-signature'];
      if (!sigOk(expected, typeof got === 'string' ? got : undefined)) return reply.code(401).send({ error: 'bad_signature' });
      const ev = (req.body ?? {}) as { event?: string; data?: { reference?: string; status?: string; amount?: number; currency?: string; metadata?: { uid?: string; plan?: string } } };
      if (ev.event !== 'charge.success' || !ev.data || ev.data.status !== 'success') return { received: true };
      const d = ev.data;
      const plan = d.metadata?.plan;
      if (!d.reference || !d.metadata?.uid || !plan || !(plan in PAYSTACK_PLANS)) return { received: true };
      const p = PAYSTACK_PLANS[plan as keyof typeof PAYSTACK_PLANS];
      if (d.amount !== p.amount || d.currency !== p.currency) return reply.code(400).send({ error: 'amount_mismatch' });
      const ok = await deps.store.activate(d.metadata.uid, plan, p.days, d.reference, d.amount!, d.currency!);
      return { received: true, activated: ok };
    });

    child.post('/v1/billing/creem/webhook', async (req, reply) => {
      const raw = (req as FastifyRequest & { rawBody?: Buffer }).rawBody ?? Buffer.from(JSON.stringify(req.body ?? {}));
      const secret = process.env.CREEM_WEBHOOK_SECRET ?? '';
      const expected = createHmac('sha256', secret).update(raw).digest('hex');
      const got = req.headers['creem-signature'] ?? req.headers['x-creem-signature'];
      if (!sigOk(expected, typeof got === 'string' ? got : undefined)) return reply.code(401).send({ error: 'bad_signature' });
      const ev = (req.body ?? {}) as { eventType?: string; event?: string; data?: { id?: string; metadata?: { uid?: string; plan?: string } } };
      const type = ev.eventType ?? ev.event ?? '';
      if (!/checkout.completed|subscription.active|paid/i.test(type)) return { received: true };
      const d = ev.data;
      const plan = d?.metadata?.plan;
      if (!d?.id || !d.metadata?.uid || !plan || !(plan in PAYSTACK_PLANS)) return { received: true };
      const p = PAYSTACK_PLANS[plan as keyof typeof PAYSTACK_PLANS];
      const ok = await deps.store.activate(d.metadata.uid, plan, p.days, d.id, 299, 'USD');
      return { received: true, activated: ok };
    });
  });
}
