/** Browser event carrying a pushed lot price from LiveUpdates to the price cells: detail = { lotId, highestBid }. */
export const LOT_PRICE_EVENT = 'telus:lot-price';

const cents = (v: string): bigint | null => {
  const m = /^(\d{1,12})(?:\.(\d{1,2}))?$/.exec(v);
  return m ? BigInt(m[1]! + (m[2] ?? '').padEnd(2, '0')) : null;
};

/**
 * The higher of two decimal price strings (null = unknown; anything malformed is ignored). A lot's price only ever
 * rises, so the newest information is always the highest: a push that arrives before the page's own data, or a page
 * render that started before the latest bid, can never make the displayed price go backwards.
 */
export function higherPrice(a: string | null | undefined, b: string | null | undefined): string | null {
  const ca = a ? cents(a) : null;
  const cb = b ? cents(b) : null;
  if (ca === null) return cb === null ? null : b!;
  if (cb === null) return a!;
  return cb > ca ? b! : a!;
}
