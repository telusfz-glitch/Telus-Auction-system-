import { createAuctionAction } from '@/app/actions/admin';
import { ActionForm } from '@/components/ActionForm';
import { LocalDateTime } from '@/components/LocalDateTime';
import { requireSession } from '@/lib/auth';
import { VISIBILITY_LABEL } from '@/lib/format';

export default async function NewAuction() {
  await requireSession('staff');
  return (
    <>
      <h1>New auction</h1>
      <p className="muted">Creates a draft. Add lots and invite customers, then schedule it; it opens and closes automatically.</p>
      <div className="panel">
        <ActionForm action={createAuctionAction} submit="Create draft" className="form stack">
          <label>Auction number <input name="number" required maxLength={40} pattern="[A-Za-z0-9][A-Za-z0-9-]*" placeholder="AUC-2026-10" /></label>
          <label>Name <input name="name" required minLength={2} maxLength={200} /></label>
          <LocalDateTime name="startAt" label="Opens" required />
          <LocalDateTime name="closeAt" label="Closes" required />
          <label>Price visibility
            <select name="bidVisibility" defaultValue="winning_losing_only">
              {Object.entries(VISIBILITY_LABEL).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </label>
          <label className="inline"><input type="checkbox" name="extensionEnabled" defaultChecked /> Anti-sniping extension</label>
          <div className="row">
            <label>Window (seconds) <input name="extensionWindowSeconds" type="number" min={10} max={3600} defaultValue={120} /></label>
            <label>Extend by (seconds) <input name="extensionSeconds" type="number" min={10} max={3600} defaultValue={120} /></label>
          </div>
        </ActionForm>
      </div>
    </>
  );
}
