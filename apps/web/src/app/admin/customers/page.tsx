import { CUSTOMER_STATUSES } from '@telus/shared';
import { createCustomerAction, setLimitAction, updateCustomerAction } from '@/app/actions/admin';
import { ActionForm } from '@/components/ActionForm';
import { api } from '@/lib/api';
import { MANAGERS, hasRole, requireSession } from '@/lib/auth';
import type { AdminCustomer, RuleSet } from '@/lib/types';

export default async function Customers() {
  const s = await requireSession('staff');
  const [customers, ruleSets] = await Promise.all([api<AdminCustomer[]>(s, '/admin/customers'), api<RuleSet[]>(s, '/admin/margin-rule-sets')]);
  const manager = hasRole(s, ...MANAGERS);
  const limits = hasRole(s, 'super_admin', 'finance');
  return (
    <>
      <h1>Customers</h1>
      <p className="muted">Customer logins are created in Keycloak (see README); here you manage the company record, status, margin rules and purchase limit.</p>
      {manager && (
        <div className="panel">
          <ActionForm action={createCustomerAction} submit="Add customer">
            <label>Company name <input name="companyName" required minLength={2} maxLength={200} /></label>
            <label>Contact email <input name="contactEmail" type="email" required maxLength={254} /></label>
          </ActionForm>
        </div>
      )}
      <div className="table-wrap">
        <table data-testid="customers">
          <thead><tr><th>Customer</th><th>Contact</th><th>Status &amp; margin rules</th><th>Purchase limit</th></tr></thead>
          <tbody>
            {customers.map((c) => (
              <tr key={c.id}>
                <td><strong>{c.code}</strong><br />{c.company_name}</td>
                <td>{c.contact_email}</td>
                <td>
                  {manager ? (
                    <ActionForm action={updateCustomerAction} submit="Save" variant="secondary" hidden={{ customerId: c.id }}>
                      <select name="status" defaultValue={c.status} aria-label={`Status of ${c.code}`}>
                        {CUSTOMER_STATUSES.map((st) => <option key={st} value={st}>{st}</option>)}
                      </select>
                      <select name="marginRuleSetId" defaultValue="" aria-label={`Margin rules of ${c.code}`}>
                        <option value="">(unchanged)</option>
                        {ruleSets.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
                      </select>
                    </ActionForm>
                  ) : c.status}
                </td>
                <td>
                  {limits && (
                    <ActionForm action={setLimitAction} submit="Set" variant="secondary" hidden={{ customerId: c.id }}>
                      <input name="maxPurchaseValue" inputMode="decimal" className="amount" placeholder="AED" required aria-label={`Limit for ${c.code}`} />
                    </ActionForm>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
