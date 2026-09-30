import type { NotificationPrefs } from '@telus/shared';
import { setNotificationPrefsAction } from '@/app/actions/team';
import { ActionForm } from '@/components/ActionForm';
import { TeamTable } from '@/components/TeamTable';
import { ApiCallError, api } from '@/lib/api';
import { requireSession } from '@/lib/auth';
import { env } from '@/lib/env';
import type { TeamUser } from '@/lib/types';

export default async function Team() {
  const s = await requireSession('customer');
  const [users, prefs] = await Promise.all([
    api<TeamUser[]>(s, '/team'),
    // A login created outside the team screens (e.g. directly in Keycloak) has no record, hence no preferences.
    api<NotificationPrefs>(s, '/me/notifications').catch((e) => { if (e instanceof ApiCallError && e.status === 404) return null; throw e; }),
  ]);
  const admin = s.customerRole === 'customer_admin';
  return (
    <>
      <h1>Team</h1>
      <p className="muted">
        {admin ? 'Logins for your company. Bidders can bid; viewers can only watch. Suspending a login signs it out everywhere.'
          : 'Logins for your company. Ask your administrator to make changes.'}
      </p>
      <TeamTable users={users} canManage={admin} selfSub={s.sub} tz={env().DISPLAY_TIMEZONE} />
      {prefs && s.customerRole !== 'customer_viewer' && (
        <div className="panel" data-testid="my-notifications">
          <h2 style={{ marginTop: 0 }}>My notifications</h2>
          <p className="muted">Results, cancellations and invoices are always emailed to your company&apos;s logins.</p>
          <ActionForm action={setNotificationPrefsAction} submit="Save">
            <label className="row">
              <input type="checkbox" name="notifyOutbid" defaultChecked={prefs.notifyOutbid} /> Email me when my company is outbid
            </label>
          </ActionForm>
        </div>
      )}
    </>
  );
}
