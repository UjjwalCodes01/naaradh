'use client';

import { useActionState, type ReactNode } from 'react';
import { useFormStatus } from 'react-dom';
import type { ActionResult } from '@/lib/actions';

/**
 * The one client component: a form bound to a server action, showing the action's message
 * (and a one-time secret, e.g. a new API key) without a page reload. Works without JS too —
 * the action still runs; only the inline message needs hydration.
 */
export function ActionForm({
  action,
  children,
  submit,
  confirm,
  className = '',
  danger = false,
}: {
  action: (state: ActionResult, form: FormData) => Promise<ActionResult>;
  children?: ReactNode;
  submit: string;
  confirm?: string;
  className?: string;
  danger?: boolean;
}) {
  const [state, formAction] = useActionState(action, { ok: true, message: '' });
  return (
    <form
      action={formAction}
      className={`space-y-3 ${className}`}
      onSubmit={(e) => {
        if (confirm !== undefined && !window.confirm(confirm)) e.preventDefault();
      }}
    >
      {children}
      <div className="flex flex-wrap items-center gap-3">
        <SubmitButton label={submit} danger={danger} />
        {state.message === '' ? null : (
          <p role="status" className={`text-sm ${state.ok ? 'text-emerald-700' : 'text-rose-700'}`}>
            {state.message}
          </p>
        )}
      </div>
      {state.secret === undefined ? null : (
        <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm">
          <p className="font-medium text-amber-900">Copy this now — it will not be shown again.</p>
          <code className="mt-2 block break-all rounded bg-white p-2 font-mono text-xs text-slate-900">
            {state.secret}
          </code>
        </div>
      )}
    </form>
  );
}

function SubmitButton({ label, danger }: { label: string; danger: boolean }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className={`rounded-md px-3 py-2 text-sm font-medium text-white shadow-sm disabled:opacity-60 ${
        danger ? 'bg-rose-600 hover:bg-rose-700' : 'bg-slate-900 hover:bg-slate-700'
      }`}
    >
      {pending ? 'Working…' : label}
    </button>
  );
}
