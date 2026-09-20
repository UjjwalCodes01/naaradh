import { listArticles, type ArticleView } from '@naaradh/pipeline';
import { ActionForm } from '@/components/action-form';
import { Badge, Card, PageHeader, inputClass } from '@/components/ui';
import { formatDate } from '@/lib/format';
import { inTenant, requireSession } from '@/lib/session';
import { tenantSettings } from '@/lib/tenant';
import { saveArticle } from './actions';

export default async function Knowledge() {
  const s = await requireSession('operator');
  const tz = (await tenantSettings()).timezone;
  const articles = await inTenant(s, (tx) => listArticles(tx, s.tenantId));
  return (
    <div className="space-y-6">
      <PageHeader
        title="Knowledge base"
        description="The only policies and facts the support agent may state besides live order data. Write them as you would answer a customer. Only published articles are used."
      />
      <Card title="New article">
        <ArticleForm />
      </Card>
      {articles.map((a) => (
        <details key={a.id} className="rounded-lg border border-slate-200 bg-white p-4">
          <summary className="flex cursor-pointer flex-wrap items-center gap-2">
            <span className="font-medium">{a.title}</span>
            <Badge tone={a.status === 'published' ? 'good' : 'neutral'}>{a.status}</Badge>
            <span className="text-xs text-slate-500">
              {a.locale} · updated {formatDate(new Date(a.updated_at), tz)}
            </span>
          </summary>
          <div className="mt-4">
            <ArticleForm article={a} />
          </div>
        </details>
      ))}
    </div>
  );
}

function ArticleForm({ article }: { article?: ArticleView }) {
  const p = article?.id ?? 'new';
  return (
    <ActionForm action={saveArticle} submit={article === undefined ? 'Create' : 'Save'}>
      {article === undefined ? null : <input type="hidden" name="id" value={article.id} />}
      <input
        id={`title-${p}`}
        name="title"
        required
        maxLength={200}
        defaultValue={article?.title}
        placeholder="Title, e.g. Return policy"
        className={inputClass}
      />
      <textarea
        name="body"
        required
        maxLength={8000}
        rows={6}
        defaultValue={article?.body}
        placeholder="Returns are accepted within 7 days of delivery…"
        className={inputClass}
      />
      <div className="grid gap-3 sm:grid-cols-3">
        <select name="locale" defaultValue={article?.locale ?? 'en-IN'} className={inputClass}>
          <option value="en-IN">English (India)</option>
          <option value="hi-IN">Hindi</option>
        </select>
        <input
          name="tags"
          defaultValue={article?.tags.join(', ')}
          placeholder="tags, comma separated"
          className={inputClass}
        />
        <select name="status" defaultValue={article?.status ?? 'draft'} className={inputClass}>
          <option value="draft">Draft</option>
          <option value="published">Published</option>
          <option value="archived">Archived</option>
        </select>
      </div>
    </ActionForm>
  );
}
