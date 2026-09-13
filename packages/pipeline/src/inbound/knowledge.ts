import { sql } from 'drizzle-orm';
import type { DbOrTx } from '@naaradh/db';

/**
 * Knowledge search for the voice agent (search_knowledge). Postgres full-text search with the
 * 'simple' configuration (see knowledge_articles in the schema), OR-ed prefix terms so a
 * spoken "return policy shoes" matches an article about returns without needing every word.
 *
 * The query string is spoken by a caller, so it is data: it is reduced to letters/digits
 * before it reaches to_tsquery, which would otherwise throw on operators like ! & | ( ).
 */

export interface KnowledgeHit {
  readonly title: string;
  readonly answer: string;
}

/** Words shorter than this carry no signal and bloat the OR query ("is", "my", "ka"). */
const MIN_TERM = 3;
const MAX_TERMS = 12;

export function toTsQuery(query: string): string | null {
  // \p{M}: Devanagari (and other Indic) vowel signs are combining marks — without them
  // "वापसी" would shatter into fragments too short to search.
  const terms = [...query.toLowerCase().matchAll(/[\p{L}\p{M}\p{N}]+/gu)]
    .map((m) => m[0])
    .filter((t) => t.length >= MIN_TERM)
    .slice(0, MAX_TERMS);
  if (terms.length === 0) return null;
  return [...new Set(terms)].map((t) => `${t}:*`).join(' | ');
}

/** Cut at a sentence boundary before `max` characters, so the agent never speaks half a rule. */
export function snippet(body: string, max: number): string {
  const clean = body.replace(/\s+/g, ' ').trim();
  if (clean.length <= max) return clean;
  const cut = clean.slice(0, max);
  const lastStop = Math.max(
    cut.lastIndexOf('. '),
    cut.lastIndexOf('? '),
    cut.lastIndexOf('! '),
    cut.lastIndexOf('। '),
  );
  return lastStop > max * 0.5
    ? cut.slice(0, lastStop + 1)
    : `${cut.slice(0, cut.lastIndexOf(' '))}…`;
}

export async function searchKnowledge(
  tx: DbOrTx,
  tenantId: string,
  query: string,
  limit: number,
  maxChars: number,
): Promise<KnowledgeHit[]> {
  const tsq = toTsQuery(query);
  if (tsq === null) return [];
  const result = await tx.execute<{ title: string; body: string }>(sql`
    select title, body
    from knowledge_articles, to_tsquery('simple', ${tsq}) q
    where tenant_id = ${tenantId} and status = 'published' and search @@ q
    order by ts_rank(search, q) desc, updated_at desc
    limit ${limit}
  `);
  return result.rows.map((r) => ({ title: r.title, answer: snippet(r.body, maxChars) }));
}
