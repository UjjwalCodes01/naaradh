import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { LEGAL } from '@/content/legal';
import { SitePage } from '@/components/site/ui';

type Params = Promise<{ slug: string }>;

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const page = LEGAL[(await params).slug];
  return page === undefined ? {} : { title: page.title, description: page.summary };
}

export default async function LegalPage({ params }: { params: Params }) {
  const page = LEGAL[(await params).slug];
  if (page === undefined) notFound();
  return (
    <SitePage>
      <article className="prose-legal max-w-3xl">
        <h1 className="text-2xl font-semibold text-ink">{page.title}</h1>
        <p className="mt-2 text-sm text-body">{page.summary}</p>
        <p className="mt-1 text-xs text-muted">Last updated {page.updated}</p>
        {page.draft ? (
          <p className="mt-4 rounded-md border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900">
            Draft — pending review by counsel. It describes how the product works today; binding
            terms follow legal review.
          </p>
        ) : null}
        {page.sections.map((s) => (
          <section key={s.heading}>
            <h2>{s.heading}</h2>
            {s.paragraphs?.map((p) => <p key={p}>{p}</p>)}
            {s.bullets === undefined ? null : (
              <ul>
                {s.bullets.map((b) => (
                  <li key={b}>{b}</li>
                ))}
              </ul>
            )}
          </section>
        ))}
      </article>
    </SitePage>
  );
}
