import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { liftPromotionalPause } from '@naaradh/compliance';
import {
  QA_RUBRIC,
  QaReviewInput,
  audit,
  explainOutcome,
  listQaQueue,
  qaAccuracy,
  submitQaReview,
} from '@naaradh/pipeline';
import { addDays } from '@naaradh/shared';
import { badge, h, when, type Raw } from '../html.js';
import { Reason, body, done, problem, render, staffActor, type ConsoleDeps } from '../support.js';

/**
 * Weekly QA review (P4-OPS-1, ADR-0010 §11) and the promotional pause lift (ADR-0010 §5).
 * Reading a transcript here is an audited staff access, like dispute review (E-74). Runbooks:
 * docs/runbooks/qa-review.md, docs/runbooks/promotional-calling.md.
 */

const pct = (n: number | null): string => (n === null ? '—' : `${(n * 100).toFixed(0)}%`);

export function registerQaRoutes(app: FastifyInstance, deps: ConsoleDeps): void {
  app.get<{ Querystring: { status?: string } }>('/qa', async (request, reply) => {
    const status = z
      .enum(['pending', 'done', 'skipped'])
      .catch('pending')
      .parse(request.query.status ?? 'pending');
    const [rows, accuracy] = await Promise.all([
      listQaQueue(deps.db, { status }),
      qaAccuracy(deps.db, addDays(deps.clock(), -28)),
    ]);
    return render(
      reply,
      request,
      'QA review',
      h`<p class="muted">Every Monday 2% of last week's human-answered calls per merchant (min 1, max 20) are sampled here. Opening a call reads its transcript — that access is logged against you.</p>
      <p><a href="/qa?status=pending">Pending</a> · <a href="/qa?status=done">Done</a> · <a href="/qa?status=skipped">Skipped</a></p>
      <table><tr><th>Week</th><th>Merchant</th><th>Call</th><th>Outcome</th><th>Status</th></tr>
      ${rows.map(
        (r) => h`<tr><td>${r.week}</td><td><a href="/tenants/${r.tenantId}">${r.tenant}</a></td>
        <td><a href="/qa/${r.id}">${r.direction} · ${r.purpose}</a><div class="muted"><code>${r.attemptId}</code></div></td>
        <td>${r.outcome === null ? '—' : explainOutcome(r.outcome).label}</td>
        <td>${badge(r.status, r.status === 'pending' ? 'warn' : r.status === 'done' ? 'good' : '')}</td></tr>`,
      )}</table>
      <h2>Extraction accuracy (last 28 days of reviews)</h2>
      <table><tr><th>Merchant</th><th>Reviewed</th><th>Extraction correct</th><th>Incidents</th></tr>
      ${accuracy.map(
        (a) => h`<tr><td><a href="/tenants/${a.tenantId}">${a.tenant}</a></td><td>${a.reviewed}</td>
        <td>${a.accuracy !== null && a.accuracy < 0.9 ? badge(pct(a.accuracy), 'bad') : pct(a.accuracy)}</td>
        <td>${a.incidents > 0 ? badge(String(a.incidents), 'bad') : '0'}</td></tr>`,
      )}</table>
      <p class="muted">Below 90% extraction accuracy: review the script and the extraction schema before the merchant scales (qa-review.md). Any incident (no disclosure, prohibited content, opt-out ignored, data before identity) is a compliance incident — follow the runbook.</p>`,
    );
  });

  app.get<{ Params: { id: string } }>('/qa/:id', async (request, reply) => {
    const [r] = await listQaQueue(deps.db, { id: request.params.id });
    if (r === undefined) return reply.code(404).send('not found');
    let transcript: Raw = h`<p class="muted">No transcript stored.</p>`;
    if (r.transcriptUri !== null) {
      if (deps.readTranscript === null)
        transcript = h`<p class="muted">Transcript storage is not configured here.</p>`;
      else {
        await audit(deps.db, {
          tenantId: r.tenantId,
          actorType: 'user',
          actorId: staffActor(request.staff ?? ''),
          action: 'transcript.accessed',
          targetType: 'call_attempt',
          targetId: r.attemptId,
          after: { purpose: 'qa_review', review_id: r.id },
        });
        const turns = await deps.readTranscript(r.transcriptUri).catch(() => null);
        transcript =
          turns === null
            ? h`<p class="muted">Transcript could not be read.</p>`
            : h`<ol>${turns.map((t) => h`<li><strong>${t.role}:</strong> ${t.text}</li>`)}</ol>`;
      }
    }
    const extracted = (r.extracted ?? {}) as Record<string, unknown>;
    const form =
      r.status !== 'pending'
        ? h`<div class="card">Reviewed by ${r.reviewer ?? '—'} ${r.reviewedAt === null ? '' : when(r.reviewedAt)} · extraction ${r.extractionCorrect === null ? '—' : r.extractionCorrect ? 'correct' : 'WRONG'}<pre>${JSON.stringify(r.scores ?? {}, null, 2)}</pre></div>`
        : h`<form method="post" action="/qa/${r.id}" class="card">
          ${QA_RUBRIC.map((q) =>
            q.kind === 'bool'
              ? h`<p><label>${q.label} <select name="${q.key}" required><option value="">—</option><option value="true">yes</option><option value="false">no</option></select></label></p>`
              : h`<p><label>${q.label} <select name="${q.key}" required><option value="">—</option>${[1, 2, 3, 4, 5].map((n) => h`<option value="${String(n)}">${String(n)}</option>`)}</select></label></p>`,
          )}
          <p><label>Extraction matches the conversation (outcome and fields) <select name="extraction_correct" required><option value="">—</option><option value="true">yes</option><option value="false">no</option></select></label></p>
          <p><textarea name="notes" rows="3" cols="80" maxlength="1000" placeholder="Notes (no customer details)"></textarea></p>
          <button>Save review</button></form>
          <form method="post" action="/qa/${r.id}/skip" class="card"><input name="reason" size="60" required minlength="10" placeholder="Why this call cannot be reviewed"> <button>Skip</button></form>`;
    return render(
      reply,
      request,
      `QA · ${r.tenant}`,
      h`<div class="card">${r.week} · ${r.direction} · ${r.purpose} · ended ${r.endedAt === null ? '—' : when(r.endedAt)} · <code>${r.attemptId}</code></div>
      <h2>What the system recorded</h2>
      <ul><li>outcome: ${r.outcome ?? '—'}</li>${Object.entries(extracted)
        .filter(([k]) => k !== 'outcome')
        .map(([k, v]) => h`<li>${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}</li>`)}</ul>
      <h2>Transcript</h2>${transcript}
      <h2>Review</h2>${form}`,
    );
  });

  app.post<{ Params: { id: string } }>('/qa/:id', async (request, reply) => {
    const back = `/qa/${encodeURIComponent(request.params.id)}`;
    try {
      const b = body(request);
      const bool = (k: string) => z.enum(['true', 'false']).parse(b[k]) === 'true';
      const review = QaReviewInput.parse({
        disclosure_ok: bool('disclosure_ok'),
        identity_ok: bool('identity_ok'),
        script_adherence: Number(b['script_adherence']),
        tone: Number(b['tone']),
        opt_out_honoured: bool('opt_out_honoured'),
        prohibited_content: bool('prohibited_content'),
        extraction_correct: bool('extraction_correct'),
        notes: (b['notes'] ?? '').trim() === '' ? null : (b['notes'] ?? '').trim(),
      });
      const ok = await submitQaReview(deps.db, {
        id: request.params.id,
        reviewer: staffActor(request.staff ?? ''),
        at: deps.clock(),
        review,
      });
      const incident =
        !review.disclosure_ok ||
        !review.identity_ok ||
        !review.opt_out_honoured ||
        review.prohibited_content;
      return await done(
        reply,
        ok ? '/qa' : back,
        ok,
        !ok
          ? 'Already reviewed.'
          : incident
            ? 'Saved. This review records a compliance incident — follow docs/runbooks/qa-review.md.'
            : 'Saved.',
      );
    } catch (error) {
      return await done(reply, back, false, problem(error));
    }
  });

  app.post<{ Params: { id: string } }>('/qa/:id/skip', async (request, reply) => {
    const back = `/qa/${encodeURIComponent(request.params.id)}`;
    try {
      const reason = Reason.parse(body(request)['reason']);
      const ok = await submitQaReview(deps.db, {
        id: request.params.id,
        reviewer: staffActor(request.staff ?? ''),
        at: deps.clock(),
        skip: true,
        notes: reason,
      });
      return await done(reply, ok ? '/qa' : back, ok, ok ? 'Skipped.' : 'Already reviewed.');
    } catch (error) {
      return await done(reply, back, false, problem(error));
    }
  });

  // ---- promotional pause (ADR-0010 §5) ------------------------------------------------------------

  app.post<{ Params: { id: string } }>(
    '/tenants/:id/promotional-resume',
    async (request, reply) => {
      const back = `/tenants/${encodeURIComponent(request.params.id)}`;
      try {
        const reason = Reason.parse(body(request)['reason']);
        const ok = await deps.db.transaction((tx) =>
          liftPromotionalPause(tx, {
            tenantId: request.params.id,
            by: staffActor(request.staff ?? ''),
            reason,
            at: deps.clock(),
          }),
        );
        return await done(
          reply,
          back,
          ok,
          ok ? 'Promotional calling resumed.' : 'Not paused — nothing to lift.',
        );
      } catch (error) {
        return await done(reply, back, false, problem(error));
      }
    },
  );
}
