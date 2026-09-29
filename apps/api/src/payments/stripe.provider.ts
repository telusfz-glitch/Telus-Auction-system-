import Stripe from 'stripe';
import type { CheckoutRequest, PaymentEvent, PaymentProvider } from './payment-provider';
import { fromMinor } from './payment-provider';

/** Stripe Checkout (hosted page). Only the events below change anything; everything else is acknowledged and ignored. */
export class StripeProvider implements PaymentProvider {
  readonly name = 'stripe' as const;
  private readonly stripe: Stripe;

  constructor(secretKey: string, private readonly webhookSecret: string, apiUrl?: string) {
    const u = apiUrl ? new URL(apiUrl) : undefined;
    this.stripe = new Stripe(secretKey, {
      maxNetworkRetries: 2,
      timeout: 15_000,
      ...(u ? { host: u.hostname, port: Number(u.port || (u.protocol === 'https:' ? 443 : 80)), protocol: u.protocol.replace(':', '') as 'http' | 'https' } : {}),
    });
  }

  async createCheckout(req: CheckoutRequest) {
    const s = await this.stripe.checkout.sessions.create({
      mode: 'payment',
      line_items: [{ quantity: 1, price_data: { currency: req.currency.toLowerCase(), unit_amount: req.amountMinor, product_data: { name: `Invoice ${req.invoiceNumber}` } } }],
      success_url: req.successUrl,
      cancel_url: req.cancelUrl,
      client_reference_id: req.invoiceId,
      metadata: { invoiceId: req.invoiceId, invoiceNumber: req.invoiceNumber },
      payment_intent_data: { metadata: { invoiceId: req.invoiceId, invoiceNumber: req.invoiceNumber } },
    }, { idempotencyKey: req.idempotencyKey });
    if (!s.url) throw new Error('provider returned no checkout URL');
    return { sessionId: s.id, url: s.url };
  }

  parseWebhook(rawBody: Buffer, signature: string): PaymentEvent | null {
    const ev = this.stripe.webhooks.constructEvent(rawBody, signature, this.webhookSecret);   // throws if forged or stale
    const s = ev.data.object as Stripe.Checkout.Session;
    switch (ev.type) {
      case 'checkout.session.completed':
      case 'checkout.session.async_payment_succeeded':
        if (s.payment_status !== 'paid') return null;   // e.g. a bank debit still pending: wait for async_payment_succeeded
        return {
          type: 'succeeded', sessionId: s.id, currency: (s.currency ?? '').toUpperCase(), amount: fromMinor(s.amount_total ?? 0),
          paymentId: typeof s.payment_intent === 'string' ? s.payment_intent : s.payment_intent?.id ?? s.id,
        };
      case 'checkout.session.expired':
        return { type: 'ended', sessionId: s.id, status: 'expired', detail: 'checkout expired' };
      case 'checkout.session.async_payment_failed':
        return { type: 'ended', sessionId: s.id, status: 'failed', detail: 'payment failed' };
      default:
        return null;
    }
  }
}
