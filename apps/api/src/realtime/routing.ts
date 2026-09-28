import type { OutboxEvent } from '../outbox/outbox.service';

/** Socket.IO rooms. A socket joins `customer:<id>` or `staff` at connect, and `auction:<id>` only after an RLS check. */
export const rooms = {
  staff: 'staff',
  customer: (id: string) => `customer:${id}`,
  auction: (id: string) => `auction:${id}`,
};

export interface Delivery { room: string; event: string; data: Record<string, unknown> }

const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);

/**
 * Decides who hears about an outbox event, and what they are told. This is where bid confidentiality is kept in the
 * realtime channel, so it is a pure function with its own tests. Rules, mirroring the HTTP API:
 * - Staff see everything.
 * - A customer learns only their OWN position: "you lead" (with their own amount) or "you were outbid".
 * - Nobody learns a competitor's identity, ever. The price reaches participants only in 'full_price' auctions.
 * - Timer changes (anti-sniping extensions) go to all participants: the close time is not a secret.
 */
export function route(ev: OutboxEvent): Delivery[] {
  const p = ev.payload;
  const auctionId = str(p['auctionId']);
  if (!auctionId) return [];
  const out: Delivery[] = [{ room: rooms.staff, event: ev.type, data: { ...p, eventId: ev.id } }];

  switch (ev.type) {
    case 'bid.accepted': {
      const lotId = str(p['lotId']);
      const leader = str(p['leaderCustomerId']);
      const previous = str(p['previousLeaderCustomerId']);
      const amount = str(p['amount']);
      if (!lotId || !leader) return out;
      const fullPrice = p['visibility'] === 'full_price';
      out.push({ room: rooms.customer(leader), event: 'lot.leading', data: { auctionId, lotId, myBid: amount } });
      if (previous && previous !== leader) {
        out.push({ room: rooms.customer(previous), event: 'lot.outbid', data: { auctionId, lotId, ...(fullPrice ? { highestBid: amount } : {}) } });
      }
      if (fullPrice) out.push({ room: rooms.auction(auctionId), event: 'lot.price', data: { auctionId, lotId, highestBid: amount } });
      if (p['extended'] === true) out.push({ room: rooms.auction(auctionId), event: 'auction.extended', data: { auctionId, closeAt: p['closeAt'] } });
      return out;
    }
    case 'auction.opened':
      out.push({ room: rooms.auction(auctionId), event: 'auction.opened', data: { auctionId, closeAt: p['closeAt'] } });
      return out;
    case 'auction.cancelled':
      out.push({ room: rooms.auction(auctionId), event: 'auction.cancelled', data: { auctionId } });
      return out;
    case 'auction.closed':
      // Lot counts are staff information; participants fetch their own results over HTTP.
      out.push({ room: rooms.auction(auctionId), event: 'auction.closed', data: { auctionId } });
      return out;
    default:
      return out; // unknown event types reach staff only — fail closed for customers
  }
}
