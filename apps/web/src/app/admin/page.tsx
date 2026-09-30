import Link from 'next/link';
import { api } from '@/lib/api';
import { MANAGERS, hasRole, requireSession } from '@/lib/auth';
import { env } from '@/lib/env';
import { STATUS_LABEL, when } from '@/lib/format';
import type { AdminAuctionRow } from '@/lib/types';

export default async function AdminHome() {
  const s = await requireSession('staff');
  const auctions = await api<AdminAuctionRow[]>(s, '/admin/auctions');
  const tz = env().DISPLAY_TIMEZONE;
  return (
    <>
      <div className="row spread">
        <h1>Auctions</h1>
        {hasRole(s, ...MANAGERS) && <Link className="btn" href="/admin/auctions/new">New auction</Link>}
      </div>
      {auctions.length === 0 ? <p className="panel">No auctions yet.</p> : (
        <div className="table-wrap">
          <table>
            <thead><tr><th>Auction</th><th>Status</th><th>Opens</th><th>Closes</th><th className="num">Lots</th><th className="num">Invited</th></tr></thead>
            <tbody>
              {auctions.map((a) => (
                <tr key={a.id}>
                  <td><Link href={`/admin/auctions/${a.id}`}>{a.name}</Link> <small className="muted">{a.number}</small></td>
                  <td><span className={`badge ${a.status}`}>{STATUS_LABEL[a.status]}</span></td>
                  <td>{when(a.start_at, tz)}</td>
                  <td>{when(a.close_at, tz)}</td>
                  <td className="num">{a.lot_count}</td>
                  <td className="num">{a.participant_count}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
