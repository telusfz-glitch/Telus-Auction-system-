import { notFound } from 'next/navigation';
import { addLotAction, auctionTransitionAction, inviteAction, lotAction, revokeAction } from '@/app/actions/admin';
import { ActionForm } from '@/components/ActionForm';
import { Countdown } from '@/components/Countdown';
import { LiveUpdates } from '@/components/LiveUpdates';
import { ApiCallError, api } from '@/lib/api';
import { MANAGERS, hasRole, requireSession } from '@/lib/auth';
import { env } from '@/lib/env';
import { STATUS_LABEL, VISIBILITY_LABEL, aed, when } from '@/lib/format';
import type { AdminAuction, AdminCustomer, AdminResults } from '@/lib/types';

const EDITABLE = ['draft', 'scheduled'];

export default async function AdminAuctionPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const s = await requireSession('staff');
  const tz = env().DISPLAY_TIMEZONE;
  let a: AdminAuction;
  try {
    a = await api<AdminAuction>(s, `/admin/auctions/${id}`);
  } catch (e) {
    if (e instanceof ApiCallError && e.status === 404) notFound();
    throw e;
  }
  const manager = hasRole(s, ...MANAGERS);
  const ended = ['closed', 'under_review', 'finalized', 'archived'].includes(a.status);
  const [customers, results] = await Promise.all([
    manager && ['draft', 'scheduled', 'live'].includes(a.status) ? api<AdminCustomer[]>(s, '/admin/customers') : Promise.resolve([]),
    ended ? api<AdminResults>(s, `/admin/auctions/${id}/results`) : Promise.resolve(null),
  ]);
  const invited = new Set(a.participants.filter((p) => p.is_allowed).map((p) => p.customer_id));
  const invitable = customers.filter((c) => !invited.has(c.id) && c.status !== 'blocked');
  const t = (op: string, label: string, variant?: string, confirm?: string) => (
    <ActionForm key={op} action={auctionTransitionAction} submit={label} variant={variant} confirm={confirm} hidden={{ auctionId: a.id, op }} />
  );

  return (
    <>
      <div className="row spread">
        <div>
          <h1>{a.name}</h1>
          <div className="row muted">
            <span>{a.number}</span>
            <span className={`badge ${a.status}`} data-testid="auction-status">{STATUS_LABEL[a.status]}</span>
            <span>{VISIBILITY_LABEL[a.bid_visibility]}</span>
            <span>{a.extension_enabled ? `Anti-sniping: +${a.extension_seconds}s within last ${a.extension_window_seconds}s` : 'No extension'}</span>
          </div>
        </div>
        <div style={{ textAlign: 'right' }}>
          {a.status === 'scheduled' && <Countdown target={a.start_at} label="Opens in" />}
          {a.status === 'live' && <Countdown target={a.close_at} label="Closes in" />}
          <div className="muted">Opens {when(a.start_at, tz)} · Closes {when(a.close_at, tz)} ({tz})</div>
        </div>
      </div>
      {['scheduled', 'live'].includes(a.status) && <LiveUpdates auctionId={a.id} lotNumbers={Object.fromEntries(a.lots.map((l) => [l.id, l.lot_number]))} />}

      {manager && (
        <div className="panel row" data-testid="transitions">
          {a.status === 'draft' && t('schedule', 'Schedule')}
          {a.status === 'scheduled' && t('unschedule', 'Back to draft', 'secondary')}
          {['closed', 'under_review'].includes(a.status) && t('finalize', 'Finalise & create invoices', undefined, 'Create invoices for all winning customers? This cannot be undone.')}
          {a.status === 'finalized' && <span data-testid="finalized-note">Finalised — invoices have been created for the winning customers.</span>}
          {['draft', 'scheduled', 'live'].includes(a.status) && t('cancel', 'Cancel auction', 'danger', 'Cancel this auction? Bidding stops immediately and it cannot be reopened.')}
        </div>
      )}

      {results && (
        <>
          <h2>Results</h2>
          <table data-testid="results">
            <thead><tr><th>Lot</th><th>Description</th><th>Outcome</th><th>Winner</th><th className="num">Qty</th><th className="num">Unit price</th><th className="num">Total</th></tr></thead>
            <tbody>{results.lots.map((r) => (
              <tr key={r.lot_id}><td>{r.lot_number}</td><td>{r.description}</td><td>{r.outcome}</td>
                <td>{r.winner_code ? `${r.winner_code} · ${r.winner_name}` : '—'}</td><td className="num">{r.quantity}</td>
                <td className="num">{aed(r.unit_price)}</td><td className="num">{aed(r.total)}</td></tr>
            ))}</tbody>
          </table>
        </>
      )}

      <h2>Lots</h2>
      <div className="table-wrap">
        <table data-testid="lots">
          <thead><tr><th>Lot</th><th>Description</th><th className="num">Qty</th><th className="num">Start</th><th className="num">Highest</th><th>Leader</th><th className="num">Bids</th><th /></tr></thead>
          <tbody>
            {a.lots.map((l) => (
              <tr key={l.id} data-testid={`lot-${l.lot_number}`}>
                <td>{l.lot_number}</td>
                <td>{l.description}{l.status === 'withdrawn' && <> <span className="badge">Withdrawn</span></>}</td>
                <td className="num">{l.quantity}</td>
                <td className="num">{aed(l.starting_price)}</td>
                <td className="num" data-testid="highest">{aed(l.highest_amount)}</td>
                <td>{l.leader_code ?? '—'}</td>
                <td className="num">{l.bid_count ?? 0}</td>
                <td className="row">
                  {manager && l.status === 'active' && ['draft', 'scheduled', 'live'].includes(a.status) && (
                    <ActionForm action={lotAction} submit="Withdraw" variant="secondary" confirm={`Withdraw lot ${l.lot_number}?`} hidden={{ auctionId: a.id, lotId: l.id, op: 'withdraw' }} />
                  )}
                  {manager && EDITABLE.includes(a.status) && (
                    <ActionForm action={lotAction} submit="Delete" variant="secondary" confirm={`Delete lot ${l.lot_number}?`} hidden={{ auctionId: a.id, lotId: l.id, op: 'delete' }} />
                  )}
                </td>
              </tr>
            ))}
            {a.lots.length === 0 && <tr><td colSpan={8} className="muted">No lots yet.</td></tr>}
          </tbody>
        </table>
      </div>
      {manager && EDITABLE.includes(a.status) && (
        <div className="panel">
          <ActionForm action={addLotAction} submit="Add lot" hidden={{ auctionId: a.id }}>
            <label>Lot no. <input name="lotNumber" required maxLength={20} size={6} /></label>
            <label>Description <input name="description" required maxLength={500} size={32} /></label>
            <label>Qty <input name="quantity" type="number" min={1} required style={{ width: 80 }} /></label>
            <label>Starting price (AED) <input name="startingPrice" inputMode="decimal" required className="amount" /></label>
            <label>Fallback increment <input name="fallbackIncrement" inputMode="decimal" placeholder="25" className="amount" /></label>
          </ActionForm>
        </div>
      )}

      <h2>Invited customers</h2>
      <div className="table-wrap">
        <table data-testid="participants">
          <thead><tr><th>Customer</th><th>Account</th><th>Access</th><th>Terms</th><th /></tr></thead>
          <tbody>
            {a.participants.map((p) => (
              <tr key={p.customer_id}>
                <td>{p.code} · {p.company_name}</td>
                <td>{p.customer_status}</td>
                <td>{p.is_allowed ? 'Invited' : 'Revoked'}</td>
                <td>{p.terms_accepted_at ? `Accepted ${when(p.terms_accepted_at, tz)}` : 'Not yet'}</td>
                <td>
                  {manager && p.is_allowed && ['draft', 'scheduled', 'live'].includes(a.status) && (
                    <ActionForm action={revokeAction} submit="Revoke" variant="secondary" confirm={`Revoke ${p.company_name}?`} hidden={{ auctionId: a.id, customerId: p.customer_id }} />
                  )}
                </td>
              </tr>
            ))}
            {a.participants.length === 0 && <tr><td colSpan={5} className="muted">Nobody invited yet.</td></tr>}
          </tbody>
        </table>
      </div>
      {manager && invitable.length > 0 && (
        <div className="panel">
          <ActionForm action={inviteAction} submit="Invite" hidden={{ auctionId: a.id }}>
            <label>Customers
              <select name="customerIds" multiple size={Math.min(6, invitable.length)} required>
                {invitable.map((c) => <option key={c.id} value={c.id}>{c.code} · {c.company_name} ({c.status})</option>)}
              </select>
            </label>
          </ActionForm>
        </div>
      )}
    </>
  );
}
