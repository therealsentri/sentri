import { createHmac, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';

export interface BillingStatus {
  plan: string;
  expiresAt: string | null;
  /** True while the 7-day trial is running or a paid plan is active. */
  premium: boolean;
  trialEndsAt: string | null;
}

/** 7 days from the first authenticated check — no client input involved. */
export const TRIAL_DAYS = 7;
const PAID = new Set(['monthly', 'yearly', 'family']);
export function isPremium(s: Pick<BillingStatus, 'plan' | 'expiresAt' | 'trialEndsAt'>, now = Date.now()): boolean {
  if (PAID.has(s.plan) && !!s.expiresAt && new Date(s.expiresAt).getTime() > now) return true;
  return !!s.trialEndsAt && new Date(s.trialEndsAt).getTime() > now;
}

export interface BillingStore {
  /** Returns the stored record; starts the trial on first call if needed. */
  status(uid: string): Promise<BillingStatus>;
  /** Returns false when the reference was already used (idempotent webhook). */
  activate(uid: string, plan: string, days: number, reference: string, amount: number, currency: string): Promise<boolean>;
}

export class PgBillingStore implements BillingStore {
  constructor(private readonly pool: Pool) {}
  async status(uid: string): Promise<BillingStatus> {
    const r = await this.pool.query('SELECT plan, plan_expires_at AS "expiresAt", trial_started_at AS "trialStartedAt" FROM users WHERE id=$1', [uid]);
    const row = r.rows[0] as { plan?: string; expiresAt?: Date | string | null; trialStartedAt?: Date | string | null } | undefined;
    let started = row?.trialStartedAt ? new Date(row.trialStartedAt) : null;
    if (!started || Number.isNaN(started.getTime())) {
      // Use the database clock value, not the app clock, so the reported end
      // always matches the stored start even across restarts.
      const set = await this.pool.query(
        'UPDATE users SET trial_started_at=now() WHERE id=$1 AND trial_started_at IS NULL RETURNING trial_started_at AS "trialStartedAt"',
        [uid],
      );
      started = new Date(set.rows[0]?.trialStartedAt ?? Date.now());
    }
    const trialEndsAt = new Date(started.getTime() + TRIAL_DAYS * 86_400_000).toISOString();
    const s = { plan: row?.plan ?? 'free', expiresAt: row?.expiresAt ? String(row.expiresAt) : null, trialEndsAt };
    return { ...s, premium: isPremium(s) };
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
  private readonly trials = new Map<string, string>();
  private readonly seen = new Set<string>();
  async status(uid: string): Promise<BillingStatus> {
    const saved = this.plans.get(uid);
    if (!this.trials.has(uid)) this.trials.set(uid, new Date().toISOString());
    const trialEndsAt = new Date(new Date(this.trials.get(uid)!).getTime() + TRIAL_DAYS * 86_400_000).toISOString();
    const s = { plan: saved?.plan ?? 'free', expiresAt: saved?.expiresAt ?? null, trialEndsAt };
    return { ...s, premium: isPremium(s) };
  }
  async activate(uid: string, plan: string, days: number, reference: string, amount: number, currency: string): Promise<boolean> {
    if (this.seen.has(reference)) return false;
    this.seen.add(reference);
    this.plans.set(uid, { plan, expiresAt: new Date(Date.now() + days * 86_400_000).toISOString(), premium: true, trialEndsAt: this.plans.get(uid)?.trialEndsAt ?? null });
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

    // Public readiness probe. No secrets are exposed: the app uses this to say
    // plainly which payment option is available instead of a generic error.
    child.get('/v1/billing/config', async () => ({
      paystack: !!process.env.PAYSTACK_SECRET_KEY,
      creem: !!process.env.CREEM_API_KEY,
    }));

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
      // International checkout sells exactly one product ($2.99 monthly).
      // A client cannot choose "family" here and upgrade itself for $2.99.
      const plan = rail === 'creem' ? 'monthly' : (b.plan && b.plan in PAYSTACK_PLANS ? b.plan as keyof typeof PAYSTACK_PLANS : 'monthly');
      if (rail === 'paystack') {
        const secret = process.env.PAYSTACK_SECRET_KEY;
        if (!secret) return reply.code(503).send({ error: 'payments_not_configured', rail: 'paystack' });
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
        if (!res.ok) return reply.code(502).send({ error: 'checkout_failed', rail: 'paystack' });
        const j = await res.json() as { data?: { authorization_url?: string; reference?: string } };
        if (!j.data?.authorization_url) return reply.code(502).send({ error: 'checkout_failed', rail: 'paystack' });
        return { url: j.data.authorization_url, reference: j.data.reference, rail, plan };
      }
      const key = process.env.CREEM_API_KEY;
      if (!key) return reply.code(503).send({ error: 'payments_not_configured', rail: 'creem' });
      const res = await fetchFn('https://api.creem.io/v1/checkouts', {
        method: 'POST',
        headers: { 'x-api-key': key, 'content-type': 'application/json' },
        body: JSON.stringify({
          product_id: CREEM_PRODUCT_ID,
          request_id: `${uid}-${Date.now()}`,
          customer: { email: (req.body as { email?: string }).email || 'buyer@sentri.com.ng' },
          success_url: 'https://sentri.com.ng/?premium=1',
          metadata: { uid, plan },
        }),
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) return reply.code(502).send({ error: 'checkout_failed', rail: 'creem' });
      const j = await res.json() as { checkout_url?: string; url?: string };
      const url = j.checkout_url ?? j.url;
      if (!url) return reply.code(502).send({ error: 'checkout_failed', rail: 'creem' });
      return { url, rail, plan };
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
              if (Number(d.amount) === p.amount && d.currency === p.currency) {
                await deps.store.activate(d.metadata.uid, d.metadata.plan, p.days, reference, p.amount, p.currency);
              }
            }
          }
        } catch (e) { deps.log?.warn({ err: e instanceof Error ? e.message : 'verify failed' }, 'billing callback'); }
      }
      return reply.redirect('https://sentri.com.ng/?premium=1');
    });

    child.post('/v1/billing/paystack/webhook', async (req, reply) => {
      const raw = (req as FastifyRequest & { rawBody?: Buffer }).rawBody ?? Buffer.from(JSON.stringify(req.body ?? {}));
      const secret = process.env.PAYSTACK_SECRET_KEY;
      // No configured secret means this webhook cannot be authenticated: reject it
      // outright rather than computing a signature with an empty key.
      if (!secret) return reply.code(401).send({ error: 'bad_signature' });
      const expected = createHmac('sha512', secret).update(raw).digest('hex');
      const got = req.headers['x-paystack-signature'];
      if (!sigOk(expected, typeof got === 'string' ? got : undefined)) return reply.code(401).send({ error: 'bad_signature' });
      const ev = (req.body ?? {}) as { event?: string; data?: { reference?: string; status?: string; amount?: number; currency?: string; metadata?: { uid?: string; plan?: string } } };
      if (ev.event !== 'charge.success' || !ev.data || ev.data.status !== 'success') return { received: true };
      const d = ev.data;
      const plan = d.metadata?.plan;
      if (!d.reference || !d.metadata?.uid || !plan || !(plan in PAYSTACK_PLANS)) return { received: true };
      const p = PAYSTACK_PLANS[plan as keyof typeof PAYSTACK_PLANS];
      if (Number(d.amount) !== p.amount || d.currency !== p.currency) return reply.code(400).send({ error: 'amount_mismatch' });
      const ok = await deps.store.activate(d.metadata.uid, plan, p.days, d.reference, d.amount!, d.currency!);
      return { received: true, activated: ok };
    });

    child.post('/v1/billing/creem/webhook', async (req, reply) => {
      const raw = (req as FastifyRequest & { rawBody?: Buffer }).rawBody ?? Buffer.from(JSON.stringify(req.body ?? {}));
      const secret = process.env.CREEM_WEBHOOK_SECRET;
      // Same rule as Paystack: an unconfigured secret must never verify a webhook.
      if (!secret) return reply.code(401).send({ error: 'bad_signature' });
      const expected = createHmac('sha256', secret).update(raw).digest('hex');
      const got = req.headers['creem-signature'] ?? req.headers['x-creem-signature'];
      if (!sigOk(expected, typeof got === 'string' ? got : undefined)) return reply.code(401).send({ error: 'bad_signature' });
      const ev = (req.body ?? {}) as { eventType?: string; event?: string; data?: { id?: string; product_id?: string; amount?: number; currency?: string; metadata?: { uid?: string } } };
      const type = ev.eventType ?? ev.event ?? '';
      if (!/checkout.completed|subscription.active|paid/i.test(type)) return { received: true };
      const d = ev.data;
      // Only the $2.99 monthly product can grant Premium here. Ignore any
      // client-sent plan metadata entirely.
      if (d?.product_id && d.product_id !== CREEM_PRODUCT_ID) return { received: true };
      if (d?.amount != null && Number(d.amount) !== 299) return reply.code(400).send({ error: 'amount_mismatch' });
      if (d?.currency && d.currency !== 'USD') return reply.code(400).send({ error: 'amount_mismatch' });
      if (!d?.id || !d.metadata?.uid) return { received: true };
      const ok = await deps.store.activate(d.metadata.uid, 'monthly', PAYSTACK_PLANS.monthly.days, d.id, 299, 'USD');
      return { received: true, activated: ok };
    });
  });
}
