import { notFound } from 'next/navigation';
import { accessMedia } from '@naaradh/pipeline';
import { isNaaradhError } from '@naaradh/shared';
import { Card, PageHeader } from '@/components/ui';
import { media } from '@/lib/server';
import { actorOf, inTenant, requireSession } from '@/lib/session';

type Params = Promise<{ attemptId: string }>;

/** Reading a transcript is an audited access, like playing the recording (E-74). */
export default async function Transcript({ params }: { params: Params }) {
  const s = await requireSession('operator');
  const { attemptId } = await params;
  const uri = await inTenant(s, (tx) => accessMedia(tx, actorOf(s), attemptId, 'transcript')).catch(
    (error: unknown) => {
      if (isNaaradhError(error) && error.code === 'NOT_FOUND') notFound();
      throw error;
    },
  );
  const turns = await media().readTranscript(uri);
  return (
    <div>
      <PageHeader
        title="Transcript"
        description="Automatic transcription — may contain errors. This view is recorded in your access log."
      />
      <Card>
        <ol className="space-y-3">
          {turns.map((t, i) => (
            <li
              key={i}
              className={`flex gap-3 text-sm ${t.role === 'agent' ? '' : 'flex-row-reverse text-right'}`}
            >
              <span className="w-20 shrink-0 text-xs font-medium uppercase text-slate-500">
                {t.role === 'agent' ? 'Agent' : 'Customer'}
              </span>
              <p
                className={`max-w-xl rounded-lg px-3 py-2 ${t.role === 'agent' ? 'bg-slate-100' : 'bg-indigo-50'}`}
              >
                {t.text}
              </p>
            </li>
          ))}
        </ol>
      </Card>
    </div>
  );
}
