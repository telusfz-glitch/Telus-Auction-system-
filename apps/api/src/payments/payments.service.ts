import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { ApiError } from '../common/api-error';
import type { Principal } from '../auth/principal';
import type { Env } from '../config/env';
import { ENV } from '../config/tokens';
import { DbService } from '../db/db.service';
import { PAYMENT_PROVIDER, toMinor, type PaymentProvider } from './payment-provider';

/**
 * Card payment of invoices through a hosted checkout. Starting: a customer admin, own unpaid invoice, exact total (the
 * database policy re-checks all three). Finishing: only the provider's signed webhook, through payment_succeeded(),
 * which settles the invoice once, for the exact amount in AED, and audits it.
 */
@Injectable()
export class PaymentsService {
  private readonly logger = new Logger('Payments');

  constructor(@Inject(ENV) private readonly env: Env, private readonly db: DbService,
              @Optional() @Inject(PAYMENT_PROVIDER) private readonly provider?: PaymentProvider) {}

  private get p(): PaymentProvider {
    if (!this.provider) throw new ApiError('PAYMENTS_DISABLED', 'Online card payment is not available. Please pay by bank transfer.', 503);
    return this.provider;
  }

  get enabled(): boolean { return !!this.provider; }

  async start(p: Principal, invoiceId: string): Promise<{ url: string }> {
    const provider = this.p;
    const inv = (await this.db.withPrincipal(p, (c) => c.query(
      'SELECT id, invoice_number, total_amount::text AS total, status FROM invoices WHERE id = $1', [invoiceId]))).rows[0];
    if (!inv) throw new ApiError('INVOICE_NOT_FOUND', 'Invoice not found.', 404);
    if (inv.status !== 'unpaid') throw new ApiError('INVOICE_NOT_PAYABLE', `This invoice is already ${inv.status}.`, 409);
    const web = this.env.PUBLIC_WEB_URL ?? 'http://localhost:3000';
    // One provider session per invoice per 30 minutes: a double click or a retry reuses it (provider idempotency).
    const window = Math.floor(Date.now() / 1_800_000);
    const session = await provider.createCheckout({
      invoiceId: inv.id, invoiceNumber: inv.invoice_number, amountMinor: toMinor(inv.total), currency: 'AED',
      successUrl: `${web}/invoices?payment=success`, cancelUrl: `${web}/invoices?payment=cancelled`,
      idempotencyKey: `invoice-${inv.id}-${p.sub}-${window}`,
    }).catch((e: unknown) => {
      this.logger.error(`checkout creation failed: ${e instanceof Error ? e.message : String(e)}`);
      throw new ApiError('PAYMENT_PROVIDER_UNAVAILABLE', 'The payment page could not be opened. Please try again.', 502);
    });
    await this.db.withPrincipal(p, (c) => c.query(
      `INSERT INTO payments (invoice_id, customer_id, provider, provider_session_id, amount, created_by)
       VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (provider_session_id) DO NOTHING`,
      [inv.id, p.customerId, provider.name, session.sessionId, inv.total, p.sub])).catch((e: { code?: string }) => {
      // The policy refused (e.g. paid in the meantime): do not send the customer to pay.
      if (e.code === '42501') throw new ApiError('INVOICE_NOT_PAYABLE', 'This invoice can no longer be paid online.', 409);
      throw e;
    });
    return { url: session.url };
  }

  /** Provider webhook. A bad signature → 400 (the provider retries genuine events; forgeries get nothing). */
  async webhook(rawBody: Buffer | undefined, signature: string | undefined): Promise<{ received: true; result: string }> {
    const provider = this.p;
    let ev;
    try {
      if (!rawBody || !signature) throw new Error('missing body or signature');
      ev = provider.parseWebhook(rawBody, signature);
    } catch {
      throw new ApiError('BAD_SIGNATURE', 'Invalid signature.', 400);
    }
    if (!ev) return { received: true, result: 'ignored' };
    const result = await this.db.withSystem(`${provider.name}-webhook`, async (c) => ev.type === 'succeeded'
      ? (await c.query('SELECT payment_succeeded($1, $2, $3, $4) AS r', [ev.sessionId, ev.paymentId, ev.amount, ev.currency])).rows[0].r
      : (await c.query('SELECT payment_ended($1, $2, $3) AS r', [ev.sessionId, ev.status, ev.detail])).rows[0].r);
    if (String(result).startsWith('rejected') || result === 'unknown') this.logger.warn(`payment ${ev.sessionId}: ${result} — needs finance attention`);
    return { received: true, result };
  }
}
