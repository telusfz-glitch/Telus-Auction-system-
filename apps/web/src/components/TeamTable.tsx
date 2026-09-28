import { CUSTOMER_ROLES } from '@telus/shared';
import { createTeamUserAction, updateTeamUserAction } from '@/app/actions/team';
import { ActionForm } from '@/components/ActionForm';
import { when } from '@/lib/format';
import type { TeamUser } from '@/lib/types';

export const ROLE_LABEL: Record<string, string> = { customer_admin: 'Administrator', customer_bidder: 'Bidder', customer_viewer: 'Viewer (read-only)' };

/** Shared by the customer /team page and the staff customer page. `selfSub` hides actions on the viewer's own login. */
export function TeamTable({ users, canManage, selfSub, customerId, tz }: {
  users: TeamUser[]; canManage: boolean; selfSub: string; customerId?: string; tz: string;
}) {
  const hidden = (u: TeamUser) => ({ userId: u.id, ...(customerId ? { customerId } : {}) });
  return (
    <>
      <div className="table-wrap">
        <table data-testid="team">
          <thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Status</th><th>Added</th>{canManage && <th />}</tr></thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id} data-testid={`member-${u.email}`}>
                <td>{u.display_name}</td>
                <td>{u.email ?? '—'}</td>
                <td>{ROLE_LABEL[u.role]}</td>
                <td><span className={`badge ${u.status === 'active' ? 'live' : 'cancelled'}`}>{u.status}</span></td>
                <td>{when(u.created_at, tz)}</td>
                {canManage && (
                  <td>
                    {u.keycloak_sub === selfSub ? <span className="muted">you</span> : (
                      <div className="row">
                        <ActionForm action={updateTeamUserAction} submit="Change role" variant="secondary" hidden={hidden(u)}>
                          <select name="role" defaultValue={u.role} aria-label={`Role of ${u.email}`}>
                            {CUSTOMER_ROLES.map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
                          </select>
                        </ActionForm>
                        <ActionForm action={updateTeamUserAction} submit={u.status === 'active' ? 'Suspend' : 'Reactivate'}
                          variant={u.status === 'active' ? 'danger' : 'secondary'}
                          confirm={u.status === 'active' ? `Suspend ${u.email}? They are signed out and cannot sign in or bid.` : undefined}
                          hidden={{ ...hidden(u), status: u.status === 'active' ? 'suspended' : 'active' }} />
                      </div>
                    )}
                  </td>
                )}
              </tr>
            ))}
            {users.length === 0 && <tr><td colSpan={6} className="muted">No logins recorded yet.</td></tr>}
          </tbody>
        </table>
      </div>
      {canManage && (
        <div className="panel">
          <h2 style={{ marginTop: 0 }}>Add a login</h2>
          <ActionForm action={createTeamUserAction} submit="Create login" hidden={customerId ? { customerId } : undefined}>
            <label>Email <input name="email" type="email" required maxLength={254} /></label>
            <label>First name <input name="firstName" required maxLength={100} /></label>
            <label>Last name <input name="lastName" required maxLength={100} /></label>
            <label>Role
              <select name="role" defaultValue="customer_bidder">
                {CUSTOMER_ROLES.map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
              </select>
            </label>
          </ActionForm>
          <p className="muted">The new user signs in with the temporary password, then must choose their own password
            {' '}and set up an authenticator app.</p>
        </div>
      )}
    </>
  );
}
