import { createRuleSetAction, updateSecurityAction } from '@/app/actions/admin';
import { ActionForm } from '@/components/ActionForm';
import { api } from '@/lib/api';
import { MANAGERS, hasRole, requireSession } from '@/lib/auth';
import { aed } from '@/lib/format';
import type { RuleSet, SecuritySettings } from '@/lib/types';

export default async function Settings() {
  const s = await requireSession('staff');
  const [sec, ruleSets] = await Promise.all([api<SecuritySettings>(s, '/admin/security-settings'), api<RuleSet[]>(s, '/admin/margin-rule-sets')]);
  const superAdmin = hasRole(s, 'super_admin');
  return (
    <>
      <h1>Settings</h1>
      <h2>Bid security limits</h2>
      <div className="panel">
        {superAdmin ? (
          <ActionForm action={updateSecurityAction} submit="Save limits">
            <label>Maximum bid (AED) <input name="maxBidLimit" defaultValue={sec.max_bid_limit} className="amount" required /></label>
            <label className="inline"><input type="checkbox" name="rangeEnabled" defaultChecked={sec.range_enabled} /> Enforce bid range</label>
            <label>Range min <input name="rangeMin" defaultValue={sec.range_min} className="amount" required /></label>
            <label>Range max <input name="rangeMax" defaultValue={sec.range_max} className="amount" required /></label>
          </ActionForm>
        ) : (
          <p>Maximum bid {aed(sec.max_bid_limit)} · Range {sec.range_enabled ? `${aed(sec.range_min)} – ${aed(sec.range_max)}` : 'off'} <span className="muted">(super admin can change)</span></p>
        )}
      </div>

      <h2>Margin rule sets</h2>
      <p className="muted">Minimum increment by current price. Each auction keeps the brackets its customers had when it was scheduled: changes here apply to auctions scheduled afterwards, never to one already scheduled or running.</p>
      <div className="grid2">
        {ruleSets.map((r) => (
          <div key={r.id} className="panel">
            <strong>{r.name}</strong> <small className="muted">· {r.customer_count} customer(s)</small>
            <table>
              <thead><tr><th className="num">From</th><th className="num">To</th><th className="num">Increment</th></tr></thead>
              <tbody>{r.brackets.map((b, i) => <tr key={i}><td className="num">{aed(b.priceFrom)}</td><td className="num">{aed(b.priceTo)}</td><td className="num">{aed(b.margin)}</td></tr>)}</tbody>
            </table>
          </div>
        ))}
      </div>
      {hasRole(s, ...MANAGERS) && (
        <div className="panel">
          <ActionForm action={createRuleSetAction} submit="Create rule set" className="form stack">
            <label>Name <input name="name" required minLength={2} maxLength={100} /></label>
            <label>Brackets — one per line: from, to, increment
              <textarea name="brackets" rows={4} required placeholder={'0, 500, 5\n500, 2000, 10\n2000, 999999999, 20'} />
            </label>
          </ActionForm>
        </div>
      )}
    </>
  );
}
