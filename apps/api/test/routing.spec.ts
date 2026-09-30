import type { OutboxEvent } from '../src/outbox/outbox.service';
import { route } from '../src/realtime/routing';

const AUC = 'aaaaaaaa-0000-4000-8000-00000000a001';
const LOT = 'aaaaaaaa-0000-4000-8000-00000000b001';
const A = 'aaaaaaaa-0000-4000-8000-00000000c00a';
const B = 'aaaaaaaa-0000-4000-8000-00000000c00b';

const bidEvent = (over: Record<string, unknown> = {}): OutboxEvent => ({
  id: '1', type: 'bid.accepted', createdAt: new Date().toISOString(),
  payload: { bidId: 7, lotId: LOT, auctionId: AUC, amount: '1234.50', leaderCustomerId: A, previousLeaderCustomerId: B,
    closeAt: '2026-01-01T10:00:00Z', extended: false, visibility: 'winning_losing_only', ...over },
});
const forRoom = (ev: OutboxEvent, room: string) => route(ev).filter((d) => d.room === room);
const nonStaff = (ev: OutboxEvent) => route(ev).filter((d) => d.room !== 'staff');

describe('Realtime routing — confidentiality of the push channel', () => {
  it('staff receive the full event', () => {
    const [d] = forRoom(bidEvent(), 'staff');
    expect(d).toMatchObject({ event: 'bid.accepted', data: { leaderCustomerId: A, amount: '1234.50' } });
  });

  it('hidden-price auction: the leader hears only their own bid; the outbid customer hears no price at all', () => {
    const ev = bidEvent();
    expect(forRoom(ev, `customer:${A}`)).toEqual([{ room: `customer:${A}`, event: 'lot.leading', data: { auctionId: AUC, lotId: LOT, myBid: '1234.50' } }]);
    expect(forRoom(ev, `customer:${B}`)).toEqual([{ room: `customer:${B}`, event: 'lot.outbid', data: { auctionId: AUC, lotId: LOT } }]);
    expect(forRoom(ev, `auction:${AUC}`)).toEqual([]);   // nothing to the room: no price, no activity signal
  });

  it.each(['winning_losing_only', 'rank_no_identity', 'own_bid_only'])(
    '%s: no customer delivery ever contains a competitor id, and only the leader sees the amount', (visibility) => {
      const ev = bidEvent({ visibility });
      for (const d of nonStaff(ev)) {
        const text = JSON.stringify(d.data);
        if (d.room === `customer:${A}`) expect(text).not.toContain(B);
        else { expect(text).not.toContain(A); expect(text).not.toContain(B); expect(text).not.toContain('1234.50'); }
      }
    });

  it('full-price auction: the price goes to the auction room and to the outbid customer, still never an identity', () => {
    const ev = bidEvent({ visibility: 'full_price' });
    expect(forRoom(ev, `auction:${AUC}`)).toEqual([{ room: `auction:${AUC}`, event: 'lot.price', data: { auctionId: AUC, lotId: LOT, highestBid: '1234.50' } }]);
    expect(forRoom(ev, `customer:${B}`)[0]!.data).toEqual({ auctionId: AUC, lotId: LOT, highestBid: '1234.50' });
    for (const d of nonStaff(ev).filter((x) => x.room !== `customer:${A}`)) expect(JSON.stringify(d.data)).not.toMatch(new RegExp(`${A}|${B}`));
  });

  it('first bid on a lot: no outbid notification; re-bid by the current leader: no outbid to themselves', () => {
    expect(forRoom(bidEvent({ previousLeaderCustomerId: null }), `customer:${B}`)).toEqual([]);
    const self = route(bidEvent({ previousLeaderCustomerId: A }));
    expect(self.filter((d) => d.event === 'lot.outbid')).toEqual([]);
  });

  it('anti-sniping extension tells every participant the new close time', () => {
    const ev = bidEvent({ extended: true, closeAt: '2026-01-01T10:02:00Z' });
    expect(forRoom(ev, `auction:${AUC}`)).toEqual([{ room: `auction:${AUC}`, event: 'auction.extended', data: { auctionId: AUC, closeAt: '2026-01-01T10:02:00Z' } }]);
  });

  it('auction.closed reaches participants without the staff-only lot counts', () => {
    const ev: OutboxEvent = { id: '2', type: 'auction.closed', createdAt: '', payload: { auctionId: AUC, status: 'closed', lotsWon: 3, lotsUnsold: 1 } };
    expect(forRoom(ev, `auction:${AUC}`)).toEqual([{ room: `auction:${AUC}`, event: 'auction.closed', data: { auctionId: AUC } }]);
  });

  it('unknown event types and malformed payloads fail closed (staff only / nothing)', () => {
    expect(nonStaff({ id: '3', type: 'something.new', createdAt: '', payload: { auctionId: AUC, secret: 1 } })).toEqual([]);
    expect(route({ id: '4', type: 'bid.accepted', createdAt: '', payload: { lotId: LOT } })).toEqual([]);
    expect(nonStaff(bidEvent({ leaderCustomerId: 42 }))).toEqual([]);
  });
});
