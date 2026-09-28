import Link from 'next/link';
import { notFound } from 'next/navigation';
import { TeamTable } from '@/components/TeamTable';
import { ApiCallError, api } from '@/lib/api';
import { MANAGERS, hasRole, requireSession } from '@/lib/auth';
import { env } from '@/lib/env';
import type { AdminCustomer, TeamUser } from '@/lib/types';

export default async function AdminCustomer({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const s = await requireSession('staff');
  const customer = (await api<AdminCustomer[]>(s, '/admin/customers')).find((c) => c.id === id);
  if (!customer) notFound();
  let users: TeamUser[] = [];
  let unavailable = false;
  try {
    users = await api<TeamUser[]>(s, `/admin/customers/${id}/users`);
  } catch (e) {
    if (!(e instanceof ApiCallError)) throw e;
    unavailable = true;
  }
  return (
    <>
      <p><Link href="/admin/customers">← Customers</Link></p>
      <h1>{customer.company_name}</h1>
      <p className="muted">{customer.code} · {customer.contact_email} · {customer.status}</p>
      <h2>Logins</h2>
      {unavailable && <p className="banner err">Logins could not be loaded.</p>}
      <TeamTable users={users} canManage={hasRole(s, ...MANAGERS)} selfSub={s.sub} customerId={id} tz={env().DISPLAY_TIMEZONE} />
    </>
  );
}
