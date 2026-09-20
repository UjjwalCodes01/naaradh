'use server';

import { revalidatePath } from 'next/cache';
import { KnowledgeInput, createArticle, updateArticle } from '@naaradh/pipeline';
import { field, optionalField, run, type ActionResult } from '@/lib/actions';
import { actorOf, inTenant, requireSession } from '@/lib/session';

function parse(form: FormData) {
  return KnowledgeInput.parse({
    title: field(form, 'title'),
    body: field(form, 'body'),
    locale: field(form, 'locale') || 'en-IN',
    tags: field(form, 'tags')
      .split(',')
      .map((t) => t.trim())
      .filter((t) => t.length > 0),
    status: field(form, 'status') || 'draft',
  });
}

export async function saveArticle(_prev: ActionResult, form: FormData): Promise<ActionResult> {
  return run(async () => {
    const s = await requireSession('operator');
    const input = parse(form);
    const id = optionalField(form, 'id');
    await inTenant(s, async (tx) => {
      if (id === null) await createArticle(tx, actorOf(s), input);
      else await updateArticle(tx, actorOf(s), id, input);
    });
    revalidatePath('/app/knowledge');
    return input.status === 'published'
      ? 'Saved and published — the agent can use it on the next call.'
      : 'Saved.';
  });
}
