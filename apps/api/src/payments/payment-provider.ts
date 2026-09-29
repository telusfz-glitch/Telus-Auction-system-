/** A hosted card-payment provider. Card data stays with the provider; we only see sessions and signed outcomes. */
export interface CheckoutRequest {
  invoiceId: string;
  invoiceNumber: string;
  /** Exact amount in fils (AED minor units) — never a float. */
  amountMinor: number;
  currency: 'AED';
  successUrl: string;
  cancelUrl: string;
  /** Same key → same session at the provider (a double click never opens two payments). */
  idempotencyKey: string;
}

export type PaymentEvent =
  | { type: 'succeeded'; sessionId: string; paymentId: string; amount: string; currency: string }
  | { type: 'ended'; sessionId: string; status: 'expired' | 'failed'; detail: string };

export interface PaymentProvider {
  readonly name: 'stripe';
  createCheckout(req: CheckoutRequest): Promise<{ sessionId: string; url: string }>;
  /** Verifies the signature over the RAW body. Throws on a bad signature; null for events we do not act on. */
  parseWebhook(rawBody: Buffer, signature: string): PaymentEvent | null;
}

export const PAYMENT_PROVIDER = Symbol('PAYMENT_PROVIDER');

/** "1234.5" / "1234.50" → 123450, exactly (no binary floating point anywhere near money). */
export function toMinor(amount: string): number {
  const m = /^(\d+)(?:\.(\d{1,2}))?$/.exec(amount.trim());
  if (!m) throw new Error(`not a money amount: ${amount}`);
  return Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0'));
}

/** 123450 → "1234.50". */
export const fromMinor = (minor: number) => `${Math.trunc(minor / 100)}.${String(minor % 100).padStart(2, '0')}`;
