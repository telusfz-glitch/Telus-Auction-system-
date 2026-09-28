/** Display helpers. Money arrives as decimal strings and is formatted as text — never through floating point. */
export function aed(value: string | null | undefined): string {
  if (value === null || value === undefined || value === '') return '—';
  const m = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(value);
  if (!m) return value;
  const int = m[2]!.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `AED ${m[1]}${int}.${(m[3] ?? '').padEnd(2, '0')}`;
}

export function when(iso: string | null | undefined, timeZone = 'Asia/Dubai'): string {
  if (!iso) return '—';
  return new Intl.DateTimeFormat('en-GB', { timeZone, dateStyle: 'medium', timeStyle: 'short' }).format(new Date(iso));
}

export const STATUS_LABEL: Record<string, string> = {
  draft: 'Draft', scheduled: 'Scheduled', live: 'Live', closing: 'Closing', closed: 'Closed', under_review: 'Under review',
  finalized: 'Finalised', archived: 'Archived', cancelled: 'Cancelled',
};
export const VISIBILITY_LABEL: Record<string, string> = {
  full_price: 'Prices visible', winning_losing_only: 'Winning / losing only', rank_no_identity: 'Rank only', own_bid_only: 'Own bid only',
};

/** "12.5" / "12.50" / "1,200" → a number with at most 2 decimals, or null. Rejects anything else. */
export function parseMoney(input: FormDataEntryValue | null): number | null {
  if (typeof input !== 'string') return null;
  const s = input.replace(/[,\s]/g, '').replace(/^AED/i, '');
  if (!/^\d{1,10}(\.\d{1,2})?$/.test(s)) return null;
  return Number(s);
}
