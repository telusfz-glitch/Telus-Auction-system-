import { randomUUID } from 'crypto';
import { notFound } from 'next/navigation';
import { acceptTermsAction, placeBidAction } from '@/app/actions/customer';
import { ActionForm } from '@/components/ActionForm';
import { Countdown } from '@/components/Countdown';
import { LivePrice } from '@/components/LivePrice';
import { LiveUpdates } from '@/components/LiveUpdates';
import { ApiCallError, api } from '@/lib/api';
import { BIDDERS, hasRole, requireSession } from '@/lib/auth';
import { env } from '@/lib/env';
import { STATUS_LABEL, VISIBILITY_LABEL, aed, when } from '@/lib/format';
import type { CustomerAuction, CustomerLot, MyResults, Position } from '@/lib/types';

const POSITION_LABEL = { no_bid: 'No bid', leading: 'Leading', outbid: 'Outbid' } as const;
const FINAL_LABEL = { no_bid: 'No bid', leading: 'Won', outbid: 'Lost' } as const;

export default async function AuctionPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const s = await requireSession('customer');
  const tz = env().DISPLAY_TIMEZONE;

  let auction: CustomerAuction & { lots: CustomerLot[] };
  try {
    auction = await api(s, `/auctions/${id}`);
  } catch (e) {
    if (e instanceof ApiCallError && e.status === 404) notFound();
    throw e;
  }
  const started = !['draft', 'scheduled'].includes(auction.status);
  const ended = ['closed', 'under_review', 'finalized', 'archived'].includes(auction.status);
  const [positions, results] = await Promise.all([
    started ? api<Position[]>(s, `/auctions/${id}/my-positions`) : Promise.resolve([] as Position[]),
    ended ? api<MyResults>(s, `/auctions/${id}/my-results`) : Promise.resolve(null),
  ]);
  const byLot = new Map(positions.map((p) => [p.lotId, p]));
  const canBid = hasRole(s, ...BIDDERS);
  const isLive = auction.status === 'live';
  const needsTerms = !auction.terms_accepted_at && ['scheduled', 'live'].includes(auction.status);
  const fullPrice = auction.bid_visibility === 'full_price';
  const lotNumbers = Object.fromEntries(auction.lots.map((l) => [l.id, l.lot_number]));

  return (
    <>
      <div className="row spread">
        <div>
          <h1>{auction.name}</h1>
          <div className="row muted">
            <span>{auction.number}</span>
            <span className={`badge ${auction.status}`} data-testid="auction-status">{STATUS_LABEL[auction.status]}</span>
            <span>{VISIBILITY_LABEL[auction.bid_visibility]}</span>
          </div>
        </div>
        <div style={{ textAlign: 'right' }}>
          {auction.status === 'scheduled' && <Countdown target={auction.start_at} label="Opens in" />}
          {isLive && <Countdown target={auction.close_at} label="Closes in" />}
          <div className="muted">{started ? (isLive ? 'Closes' : 'Closed') : 'Opens'} {when(started ? auction.close_at : auction.start_at, tz)} ({tz})</div>
        </div>
      </div>

      {(isLive || auction.status === 'scheduled') && <LiveUpdates auctionId={auction.id} lotNumbers={lotNumbers} />}
      {auction.status === 'cancelled' && <p className="banner err">This auction was cancelled.</p>}

      {needsTerms && (
        <div className="banner warn">
          {canBid ? (
            <ActionForm action={acceptTermsAction} submit="Accept terms" hidden={{ auctionId: auction.id }}>
              <span>You must accept this auction’s terms and conditions before you can bid.</span>
            </ActionForm>
          ) : (
            <span>Your company’s administrator or a bidder must accept the terms before bidding.</span>
          )}
        </div>
      )}

      {results && (
        <>
          <h2>Your results</h2>
          {results.lotsWon.length === 0 ? <p className="panel">You did not win any lots in this auction.</p> : (
            <table data-testid="results">
              <thead><tr><th>Lot</th><th>Description</th><th className="num">Qty</th><th className="num">Unit price</th><th className="num">Total</th></tr></thead>
              <tbody>{results.lotsWon.map((r) => (
                <tr key={r.lot_id}><td>{r.lot_number}</td><td>{r.description}</td><td className="num">{r.quantity}</td>
                  <td className="num">{aed(r.unit_price)}</td><td className="num">{aed(r.total)}</td></tr>
              ))}</tbody>
            </table>
          )}
        </>
      )}

      <h2>Lots</h2>
      <div className="table-wrap">
        <table data-testid="lots">
          <thead>
            <tr>
              <th>Lot</th><th>Description</th><th className="num">Qty</th><th className="num">Starting price</th>
              {fullPrice && <th className="num">Current bid</th>}
              {started && <><th className="num">Your bid</th><th>Position</th></>}
              {isLive && canBid && !needsTerms && <th>Bid (per unit)</th>}
            </tr>
          </thead>
          <tbody>
            {auction.lots.map((lot) => {
              const pos = byLot.get(lot.id);
              return (
                <tr key={lot.id} data-testid={`lot-${lot.lot_number}`}>
                  <td>{lot.lot_number}</td>
                  <td>{lot.description}{lot.status === 'withdrawn' && <> <span className="badge">Withdrawn</span></>}</td>
                  <td className="num">{lot.quantity}</td>
                  <td className="num">{aed(lot.starting_price)}</td>
                  {fullPrice && <td className="num"><LivePrice lotId={lot.id} serverValue={pos?.currentHighestBid} /></td>}
                  {started && <>
                    <td className="num" data-testid="my-bid">{aed(pos?.myHighestBid)}</td>
                    <td><span className={`badge ${pos?.status ?? ''}`} data-testid="position">{(ended ? FINAL_LABEL : POSITION_LABEL)[pos?.status ?? 'no_bid']}</span></td>
                  </>}
                  {isLive && canBid && !needsTerms && (
                    <td>
                      {lot.status === 'active' && (
                        // A fresh idempotency key per render: re-submitting the same form cannot create two bids.
                        <ActionForm key={`${lot.id}-${pos?.myHighestBid ?? ''}`} action={placeBidAction} submit="Bid"
                          hidden={{ auctionId: auction.id, lotId: lot.id, idempotencyKey: randomUUID() }}>
                          <input name="amount" className="amount" inputMode="decimal" required aria-label={`Bid for lot ${lot.lot_number}`}
                            placeholder={pos?.minNextBid ? `min ${pos.minNextBid}` : 'AED'} />
                        </ActionForm>
                      )}
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {isLive && !fullPrice && <p className="muted">In this auction you see only your own position, never other bidders’ prices.</p>}
    </>
  );
}
