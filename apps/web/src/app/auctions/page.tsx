import Link from 'next/link';
import { api } from '@/lib/api';
import { requireSession } from '@/lib/auth';
import { env } from '@/lib/env';
import { STATUS_LABEL, VISIBILITY_LABEL, when } from '@/lib/format';
import type { CustomerAuction } from '@/lib/types';

export default async function MyAuctions() {
  const s = await requireSession('customer');
  const auctions = await api<CustomerAuction[]>(s, '/auctions');
  const tz = env().DISPLAY_TIMEZONE;
  return (
    <>
      <h1>My auctions</h1>
      <p className="muted">Auctions you have been invited to. Times are shown in {tz}.</p>
      {auctions.length === 0 ? (
        <p className="panel">You have no auction invitations yet.</p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead><tr><th>Auction</th><th>Status</th><th>Opens</th><th>Closes</th><th>Prices</th><th>Terms</th></tr></thead>
            <tbody>
              {auctions.map((a) => (
                <tr key={a.id}>
                  <td><Link href={`/auctions/${a.id}`}>{a.name}</Link> <small className="muted">{a.number}</small></td>
                  <td><span className={`badge ${a.status}`}>{STATUS_LABEL[a.status]}</span></td>
                  <td>{when(a.start_at, tz)}</td>
                  <td>{when(a.close_at, tz)}</td>
                  <td>{VISIBILITY_LABEL[a.bid_visibility]}</td>
                  <td>{a.terms_accepted_at ? 'Accepted' : <strong>Not accepted</strong>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
