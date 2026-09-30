/** One claimed email job, as returned by the email_claim() database function. */
export interface EmailJob {
  id: string;
  kind: 'lot.outbid' | 'auction.won' | 'auction.cancelled' | 'invoice.issued';
  customerCode: string;
  companyName: string;
  recipients: string[];
  auctionId: string | null;
  auctionNumber: string | null;
  auctionName: string | null;
  details: Record<string, unknown>;
}
export interface RenderedEmail { subject: string; text: string; html: string }
export interface RenderOptions { webUrl?: string; timeZone: string }

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
/** Subjects are single-line: staff-entered names must not be able to inject header lines. */
const oneLine = (s: string) => s.replace(/[\r\n\t]+/g, ' ').slice(0, 200);

/** Decimal string → "AED 1,234.50", as text (no floating point). */
export function aed(v: unknown): string {
  const m = /^(\d+)(?:\.(\d{1,2}))?$/.exec(String(v ?? ''));
  if (!m) return '—';
  return `AED ${m[1]!.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${(m[2] ?? '').padEnd(2, '0')}`;
}

function when(iso: unknown, timeZone: string): string {
  const d = new Date(String(iso));
  if (Number.isNaN(d.getTime())) return '';
  return `${new Intl.DateTimeFormat('en-GB', { timeZone, dateStyle: 'medium', timeStyle: 'short' }).format(d)} (${timeZone})`;
}

function wrap(title: string, paragraphs: string[], link?: { href: string; label: string }): { text: string; html: string } {
  const text = [...paragraphs.map((p) => p.replace(/<[^>]+>/g, '')), link ? `${link.label}: ${link.href}` : '', '', '— TELUS Auctions']
    .filter((x, i, a) => x !== '' || a[i - 1] !== '').join('\n\n');
  const html = `<!doctype html><html><body style="font-family:system-ui,sans-serif;color:#1d2330;max-width:560px">
<h2 style="color:#4b286d">${esc(title)}</h2>
${paragraphs.map((p) => `<p>${p}</p>`).join('\n')}
${link ? `<p><a href="${esc(link.href)}" style="background:#4b286d;color:#fff;padding:8px 14px;border-radius:6px;text-decoration:none">${esc(link.label)}</a></p>` : ''}
<p style="color:#5d6677;font-size:12px">TELUS Auctions — you receive this because your company takes part in TELUS device auctions.</p>
</body></html>`;
  return { text, html };
}

/**
 * Renders a notification. Paragraphs are built from ESCAPED values only (they end up in HTML); the plain-text part
 * strips the few tags used for emphasis. Confidentiality: an outbid notice never names the other bidder, and shows the
 * price only if the database put it in the job (it does so only for 'full_price' auctions).
 */
export function renderEmail(job: EmailJob, o: RenderOptions): RenderedEmail {
  const auction = `${esc(job.auctionName)} (${esc(job.auctionNumber)})`;
  const auctionLink = o.webUrl && job.auctionId ? { href: `${o.webUrl}/auctions/${job.auctionId}`, label: 'Open the auction' } : undefined;
  const d = job.details ?? {};
  switch (job.kind) {
    case 'lot.outbid': {
      const price = d['highestBid'] !== null && d['highestBid'] !== undefined ? ` The highest bid is now <strong>${esc(aed(d['highestBid']))}</strong>.` : '';
      const { text, html } = wrap('You have been outbid', [
        `Another bidder has placed a higher bid on lot <strong>${esc(d['lotNumber'])}</strong> — ${esc(d['description'])} — in ${auction}.${price}`,
        `The auction closes ${esc(when(d['closeAt'], o.timeZone))}. You can place a new bid until then.`,
      ], auctionLink);
      return { subject: oneLine(`Outbid on lot ${d['lotNumber']} — ${job.auctionName}`), text, html };
    }
    case 'auction.won': {
      const lots = Array.isArray(d['lots']) ? (d['lots'] as Array<Record<string, unknown>>) : [];
      const rows = lots.map((l) => `Lot <strong>${esc(l['lotNumber'])}</strong> — ${esc(l['description'])}: ${esc(l['quantity'])} × ${esc(aed(l['unitPrice']))} = ${esc(aed(l['total']))}`);
      const { text, html } = wrap(`Your results: ${job.auctionName ?? ''}`, [
        `${esc(job.companyName)} won ${lots.length} lot(s) in ${auction}:`,
        ...rows,
        `Total: <strong>${esc(aed(d['grandTotal']))}</strong>. TELUS will confirm the results and send the invoice.`,
      ], auctionLink);
      return { subject: oneLine(`You won ${lots.length} lot(s) — ${job.auctionName}`), text, html };
    }
    case 'auction.cancelled': {
      const { text, html } = wrap('Auction cancelled', [
        `${auction} has been cancelled by TELUS. Bids placed in it will not be honoured and no lots will be allocated.`,
      ]);
      return { subject: oneLine(`Cancelled: ${job.auctionName}`), text, html };
    }
    case 'invoice.issued': {
      const { text, html } = wrap(`Invoice ${d['invoiceNumber'] ?? ''}`, [
        `Invoice <strong>${esc(d['invoiceNumber'])}</strong> for ${auction} has been issued to ${esc(job.companyName)} (${esc(job.customerCode)}).`,
        `Amount due: <strong>${esc(aed(d['total']))}</strong>. Payment instructions follow from TELUS Finance.`,
      ], o.webUrl ? { href: `${o.webUrl}/invoices`, label: 'View invoices' } : undefined);
      return { subject: oneLine(`Invoice ${d['invoiceNumber']} — ${aed(d['total'])}`), text, html };
    }
  }
}
