'use client';

import { useActionState, type ReactNode } from 'react';
import { useFormStatus } from 'react-dom';
import type { ActionResult } from '@/lib/api';

type Action = (prev: ActionResult, form: FormData) => Promise<ActionResult>;

function Submit({ label, variant }: { label: string; variant?: string }) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className={`btn ${variant ?? ''}`} disabled={pending} aria-busy={pending}>
      {pending ? 'Working…' : label}
    </button>
  );
}

/** A form bound to a server action, with a pending state and the action's message shown inline. */
export function ActionForm({ action, submit, children, variant, confirm, className, hidden }: {
  action: Action; submit: string; children?: ReactNode; variant?: string; confirm?: string; className?: string;
  hidden?: Record<string, string>;
}) {
  const [state, formAction] = useActionState(action, null);
  return (
    <form
      action={formAction}
      className={className ?? 'form'}
      onSubmit={(e) => { if (confirm && !window.confirm(confirm)) e.preventDefault(); }}
    >
      {hidden && Object.entries(hidden).map(([k, v]) => <input key={k} type="hidden" name={k} value={v} />)}
      {children}
      <Submit label={submit} variant={variant} />
      {state && <p role="status" className={state.ok ? 'msg ok' : 'msg err'}>{state.message}</p>}
    </form>
  );
}
