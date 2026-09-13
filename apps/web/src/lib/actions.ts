import { ZodError } from 'zod';
import { isNaaradhError } from '@naaradh/shared';
import { log } from './server';

/**
 * Every server action returns an ActionResult for <ActionForm>. Expected failures (validation,
 * permissions, not found) become a message for the user; anything else is logged with a
 * reference and shown generically — internals never reach the browser.
 */
export interface ActionResult {
  readonly ok: boolean;
  readonly message: string;
  /** A value shown once and never again (a new API key). */
  readonly secret?: string;
}

export const initialResult: ActionResult = { ok: true, message: '' };

export function field(form: FormData, name: string): string {
  const v = form.get(name);
  return typeof v === 'string' ? v : '';
}

export function optionalField(form: FormData, name: string): string | null {
  const v = field(form, name).trim();
  return v === '' ? null : v;
}

export function checkbox(form: FormData, name: string): boolean {
  return form.get(name) === 'on' || form.get(name) === 'true';
}

export async function run(fn: () => Promise<string | ActionResult>): Promise<ActionResult> {
  try {
    const r = await fn();
    return typeof r === 'string' ? { ok: true, message: r } : r;
  } catch (error) {
    if (error instanceof ZodError)
      return {
        ok: false,
        message: error.issues
          .map((i) => (i.path.length > 0 ? `${i.path.join('.')}: ${i.message}` : i.message))
          .join('; '),
      };
    if (isNaaradhError(error) && error.code !== 'INTERNAL') {
      const ctx = error.context as Record<string, unknown> | undefined;
      const detail = typeof ctx?.['errors'] === 'string' ? ` (${ctx['errors']})` : '';
      return { ok: false, message: `${error.message}${detail}` };
    }
    // Next's redirect()/notFound() are thrown signals, not failures.
    if (
      error instanceof Error &&
      'digest' in error &&
      String((error as { digest: unknown }).digest).startsWith('NEXT_')
    )
      throw error;
    const ref = Math.random().toString(36).slice(2, 10);
    log().error({ err: error, ref }, 'dashboard action failed');
    return { ok: false, message: `Something went wrong (ref ${ref}). Please try again.` };
  }
}
