import { TeamTable } from '@/components/TeamTable';
import { api } from '@/lib/api';
import { requireSession } from '@/lib/auth';
import { env } from '@/lib/env';
import type { TeamUser } from '@/lib/types';

export default async function Team() {
  const s = await requireSession('customer');
  const users = await api<TeamUser[]>(s, '/team');
  const admin = s.customerRole === 'customer_admin';
  return (
    <>
      <h1>Team</h1>
      <p className="muted">
        {admin ? 'Logins for your company. Bidders can bid; viewers can only watch. Suspending a login signs it out everywhere.'
          : 'Logins for your company. Ask your administrator to make changes.'}
      </p>
      <TeamTable users={users} canManage={admin} selfSub={s.sub} tz={env().DISPLAY_TIMEZONE} />
    </>
  );
}
