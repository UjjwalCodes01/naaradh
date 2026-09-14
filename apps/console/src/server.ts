import Fastify, { type FastifyInstance } from 'fastify';
import { and, desc, eq, gte, inArray, lte, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { schema } from '@naaradh/db';
import {
  COMPLAINT_WINDOW_DAYS,
  ERASURE_COMPLETION_TARGET_DAYS,
  resolveComplaint,
  resumeTenant,
  setKillSwitch,
  suppress,
} from '@naaradh/compliance';
import { audit, explainOutcome, resolveDispute } from '@naaradh/pipeline';
import { NaaradhError, addDays, fastifyLoggerOptions, newId, trustProxyOf } from '@naaradh/shared';
import { badge, h, when, type Raw } from './html.js';
import {
  Reason,
  body,
  done,
  phoneHashOf,
  problem,
  render,
  staffActor,
  type ConsoleDeps,
} from './support.js';
import { registerNumberRoutes } from './routes/numbers.js';
import { registerMerchantRoutes } from './routes/merchants.js';

export type { ConsoleDeps } from './support.js';

/**
 * Staff console (P2-OPS). Every route requires a verified staff identity (IAP in production);
 * every POST requires a same-origin `Origin` header; every action writes audit_log as
 * `staff:<email>`. Service role: this is the cross-tenant operator's tool, not a merchant surface.
 */

export async function buildConsole(deps: ConsoleDeps): Promise<FastifyInstance> {
  const app = Fastify({
    logger: fastifyLoggerOptions(deps.logLevel ?? process.env['LOG_LEVEL'] ?? 'info'),
    trustProxy: trustProxyOf(deps.trustProxyHops),
    bodyLimit: 32 * 1024,
  });

  app.addContentTypeParser(
    'application/x-www-form-urlencoded',
    { parseAs: 'string' },
    (_req, raw, done_) => {
      done_(
        null,
        Object.fromEntries(
          new URLSearchParams(typeof raw === 'string' ? raw : raw.toString('utf8')),
        ),
      );
    },
  );

  app.get('/healthz', async () => ({ ok: true }));

  app.addHook('onRequest', async (request, reply) => {
    if (request.url === '/healthz') return;
    const email = await deps.authenticate(request);
    if (email === null) return reply.code(403).type('text/plain').send('Naaradh staff only.');
    request.staff = email;
    reply.header('cache-control', 'no-store');
    reply.header('x-frame-options', 'DENY');
    reply.header(
      'content-security-policy',
      "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
    );
    reply.header('referrer-policy', 'no-referrer');
    if (request.method === 'POST' && request.headers.origin !== deps.origin)
      return reply.code(403).type('text/plain').send('Cross-origin request refused.');
    return undefined;
  });

  // ---- overview ---------------------------------------------------------------------------------

  app.get('/', async (request, reply) => {
    const now = deps.clock();
    const since = addDays(now, -COMPLAINT_WINDOW_DAYS);
    const count = async (q: Promise<{ n: number }[]>) => (await q)[0]?.n ?? 0;
    const n = sql<number>`count(*)::int`;
    const [paused, complaints, disputes, overdue, switches] = await Promise.all([
      count(
        deps.db
          .select({ n })
          .from(schema.tenants)
          .where(inArray(schema.tenants.status, ['paused', 'suspended'])),
      ),
      count(
        deps.db
          .select({ n })
          .from(schema.complaints)
          .where(gte(schema.complaints.receivedAt, since)),
      ),
      count(
        deps.db
          .select({ n })
          .from(schema.outcomeDisputes)
          .where(eq(schema.outcomeDisputes.status, 'open')),
      ),
      count(
        deps.db
          .select({ n })
          .from(schema.erasureRequests)
          .where(
            and(
              inArray(schema.erasureRequests.status, ['requested', 'in_progress', 'failed']),
              lte(schema.erasureRequests.dueAt, now),
            ),
          ),
      ),
      count(
        deps.db.select({ n }).from(schema.killSwitches).where(eq(schema.killSwitches.active, true)),
      ),
    ]);
    return render(
      reply,
      request,
      'Overview',
      h`<table><tr><th>Paused / suspended tenants</th><th>Complaints (${COMPLAINT_WINDOW_DAYS} d)</th><th>Open disputes</th><th>Overdue erasures</th><th>Active kill switches</th></tr>
      <tr><td><a href="/tenants?status=paused">${paused}</a></td><td><a href="/complaints">${complaints}</a></td><td><a href="/disputes">${disputes}</a></td>
      <td>${overdue > 0 ? badge(String(overdue), 'bad') : '0'}</td><td>${switches > 0 ? badge(String(switches), 'warn') : '0'}</td></tr></table>
      <p class="muted">Runbooks: docs/runbooks/complaint-received.md, billing-dispute.md, erasure-request.md, kill-switch.md.</p>`,
    );
  });

  // ---- tenants ------------------------------------------------------------------------------------

  app.get<{ Querystring: { q?: string; status?: string } }>('/tenants', async (request, reply) => {
    const q = (request.query.q ?? '').trim().slice(0, 100);
    const status = request.query.status === 'paused' ? ['paused', 'suspended'] : null;
    const rows = await deps.db
      .select({
        id: schema.tenants.id,
        name: schema.tenants.name,
        status: schema.tenants.status,
        billing: schema.tenants.billingStatus,
        pausedReason: schema.tenants.pausedReason,
        createdAt: schema.tenants.createdAt,
      })
      .from(schema.tenants)
      .where(
        and(
          q === ''
            ? sql`true`
            : or(sql`${schema.tenants.name} ilike ${`%${q}%`}`, eq(schema.tenants.id, q)),
          status === null
            ? sql`true`
            : inArray(schema.tenants.status, status as ('paused' | 'suspended')[]),
        ),
      )
      .orderBy(desc(schema.tenants.createdAt))
      .limit(200);
    return render(
      reply,
      request,
      'Tenants',
      h`<form method="get"><input name="q" value="${q}" placeholder="name or ten_ id"> <button>Search</button> <a href="/tenants/new" style="margin-left:12px">+ New merchant (API / website)</a></form>
      <table><tr><th>Tenant</th><th>Status</th><th>Billing</th><th>Created</th></tr>
      ${rows.map(
        (
          t,
        ) => h`<tr><td><a href="/tenants/${t.id}">${t.name}</a><div class="muted"><code>${t.id}</code></div></td>
        <td>${badge(t.status, t.status === 'active' ? 'good' : t.status === 'pending_review' ? '' : 'warn')} <span class="muted">${t.pausedReason ?? ''}</span></td>
        <td>${t.billing}</td><td>${when(t.createdAt)}</td></tr>`,
      )}</table>`,
    );
  });

  app.get<{ Params: { id: string } }>('/tenants/:id', async (request, reply) => {
    const [t] = await deps.db
      .select()
      .from(schema.tenants)
      .where(eq(schema.tenants.id, request.params.id))
      .limit(1);
    if (t === undefined) return reply.code(404).send('not found');
    const since = addDays(deps.clock(), -COMPLAINT_WINDOW_DAYS);
    const [users, complaints, integrations, switches] = await Promise.all([
      deps.db
        .select({
          email: schema.users.email,
          role: schema.users.role,
          disabledAt: schema.users.disabledAt,
        })
        .from(schema.users)
        .where(eq(schema.users.tenantId, t.id)),
      deps.db
        .select({
          id: schema.complaints.id,
          source: schema.complaints.source,
          status: schema.complaints.status,
          receivedAt: schema.complaints.receivedAt,
        })
        .from(schema.complaints)
        .where(and(eq(schema.complaints.tenantId, t.id), gte(schema.complaints.receivedAt, since))),
      deps.db
        .select({
          kind: schema.integrations.kind,
          externalId: schema.integrations.externalId,
          status: schema.integrations.status,
        })
        .from(schema.integrations)
        .where(eq(schema.integrations.tenantId, t.id)),
      deps.db
        .select()
        .from(schema.killSwitches)
        .where(
          and(
            inArray(schema.killSwitches.scope, ['tenant', 'inbound']),
            eq(schema.killSwitches.key, t.id),
          ),
        ),
    ]);
    const sw = (scope: 'tenant' | 'inbound') =>
      switches.find((s) => s.scope === scope)?.active === true;
    return render(
      reply,
      request,
      t.name,
      h`<div class="card"><code>${t.id}</code> · ${badge(t.status)} ${t.pausedReason === null ? '' : h`<span class="muted">(${t.pausedReason})</span>`}
      · billing ${t.billingStatus} · ${t.country} · plan ${t.planCode ?? '—'} / ${t.inboundPlanCode ?? '—'}</div>
      <h2>Actions</h2>
      <div class="card">
        ${
          t.status === 'paused'
            ? h`<form method="post" action="/tenants/${t.id}/resume"><input name="reason" size="60" required minlength="10" placeholder="Why it is safe to resume (reviewed complaints, …)"> <button>Resume calling</button></form>`
            : ''
        }
        ${
          t.status !== 'suspended'
            ? h`<form method="post" action="/tenants/${t.id}/suspend" style="margin-top:8px"><input name="reason" size="60" required minlength="10" placeholder="AUP breach, fraud, … (the merchant sees a suspended banner)"> <button class="danger">Suspend</button></form>`
            : h`<p class="muted">Suspended accounts are lifted by setting status manually after review (kill-switch.md).</p>`
        }
        ${(['tenant', 'inbound'] as const).map(
          (
            scope,
          ) => h`<form method="post" action="/kill-switches" style="margin-top:8px"><input type="hidden" name="scope" value="${scope}"><input type="hidden" name="key" value="${t.id}">
          <input type="hidden" name="active" value="${sw(scope) ? 'false' : 'true'}"><input name="reason" size="40" required minlength="10" placeholder="reason">
          <button class="${sw(scope) ? '' : 'danger'}">${sw(scope) ? `Turn OFF ${scope} kill switch` : `Turn ON ${scope} kill switch`}</button></form>`,
        )}
      </div>
      <h2>DLT principal entity (promotional calling)</h2>
      <div class="card">PE id: <code>${t.dltPeId ?? '—'}</code> · ${
        t.dltLinkedAt === null
          ? badge('not linked — promotional blocked', 'warn')
          : badge(`linked ${when(t.dltLinkedAt)}`, 'good')
      }
        <form method="post" action="/tenants/${t.id}/dlt" style="margin-top:8px">
          <input name="dlt_pe_id" size="22" value="${t.dltPeId ?? ''}" placeholder="PE id (15–20 digits)">
          <input type="hidden" name="linked" value="${t.dltLinkedAt === null ? 'true' : 'false'}">
          <input name="evidence" size="50" required minlength="10" placeholder="What you checked on the DLT portal, date, reference">
          <button class="${t.dltLinkedAt === null ? '' : 'danger'}">${t.dltLinkedAt === null ? 'Mark PE linked to Naaradh' : 'Remove DLT link'}</button>
        </form>
        <p class="muted">Only after seeing on the DLT portal that this PE authorised Naaradh as its telemarketer (docs/go-live/02-phone-numbers-and-dlt.md §3). <a href="/numbers?tenant=${t.id}">Numbers owned by this tenant →</a></p>
      </div>
      <h2>Complaints (${COMPLAINT_WINDOW_DAYS} days)</h2>
      <table><tr><th>Received</th><th>Source</th><th>Status</th></tr>${complaints.map((c) => h`<tr><td>${when(c.receivedAt)}</td><td>${c.source}</td><td>${c.status}</td></tr>`)}</table>
      <h2>People</h2>
      <table><tr><th>Email</th><th>Role</th></tr>${users.map((u) => h`<tr><td>${u.email}${u.disabledAt === null ? '' : ' (removed)'}</td><td>${u.role}</td></tr>`)}</table>
      <h2>Integrations</h2>
      <table><tr><th>Kind</th><th>Account</th><th>Status</th></tr>${integrations.map((i) => h`<tr><td>${i.kind}</td><td>${i.externalId}</td><td>${i.status}</td></tr>`)}</table>`,
    );
  });

  app.post<{ Params: { id: string } }>('/tenants/:id/resume', async (request, reply) => {
    const back = `/tenants/${encodeURIComponent(request.params.id)}`;
    try {
      const reason = Reason.parse(body(request)['reason']);
      const ok = await deps.db.transaction((tx) =>
        resumeTenant(tx, {
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
        ok ? 'Resumed.' : 'Not resumed: the tenant is not paused (or was uninstalled).',
      );
    } catch (error) {
      return await done(reply, back, false, problem(error));
    }
  });

  app.post<{ Params: { id: string } }>('/tenants/:id/suspend', async (request, reply) => {
    const back = `/tenants/${encodeURIComponent(request.params.id)}`;
    try {
      const reason = Reason.parse(body(request)['reason']);
      const now = deps.clock();
      await deps.db.transaction(async (tx) => {
        const rows = await tx
          .update(schema.tenants)
          .set({
            status: 'suspended',
            pausedAt: now,
            pausedReason: `staff:${reason.slice(0, 200)}`,
          })
          .where(eq(schema.tenants.id, request.params.id))
          .returning({ id: schema.tenants.id });
        if (rows.length === 0) throw new NaaradhError('NOT_FOUND', 'tenant not found');
        await audit(tx, {
          tenantId: request.params.id,
          actorType: 'user',
          actorId: staffActor(request.staff ?? ''),
          action: 'tenant.suspended',
          targetType: 'tenant',
          targetId: request.params.id,
          after: { reason },
        });
      });
      return await done(
        reply,
        back,
        true,
        'Suspended. Dispatch and inbound answering stop within seconds.',
      );
    } catch (error) {
      return await done(reply, back, false, problem(error));
    }
  });

  // ---- complaints -----------------------------------------------------------------------------------

  app.get('/complaints', async (request, reply) => {
    const rows = await deps.db
      .select({
        id: schema.complaints.id,
        tenantId: schema.complaints.tenantId,
        tenant: schema.tenants.name,
        source: schema.complaints.source,
        status: schema.complaints.status,
        externalRef: schema.complaints.externalRef,
        receivedAt: schema.complaints.receivedAt,
      })
      .from(schema.complaints)
      .innerJoin(schema.tenants, eq(schema.tenants.id, schema.complaints.tenantId))
      .orderBy(desc(schema.complaints.receivedAt))
      .limit(200);
    const pending = await deps.db
      .select({ n: sql<number>`count(*)::int` })
      .from(schema.complaintReports)
      .where(eq(schema.complaintReports.status, 'pending'));
    return render(
      reply,
      request,
      'Complaints',
      h`<p class="muted">${pending[0]?.n ?? 0} reports waiting for the complaints worker. Marking a complaint invalid removes it from the E-05 counters; it does not resume a paused tenant.</p>
      <table><tr><th>Received</th><th>Tenant</th><th>Source</th><th>Status</th><th>Decide</th></tr>
      ${rows.map(
        (
          c,
        ) => h`<tr><td>${when(c.receivedAt)}</td><td><a href="/tenants/${c.tenantId}">${c.tenant}</a></td><td>${c.source} <span class="muted">${c.externalRef ?? ''}</span></td>
        <td>${badge(c.status, c.status === 'invalid' ? '' : 'warn')}</td>
        <td>${
          c.status === 'received'
            ? h`<form method="post" action="/complaints/${c.id}/resolve" class="inline"><select name="status"><option value="valid">valid</option><option value="invalid">invalid</option></select>
          <input name="notes" placeholder="notes" size="24"> <button>Save</button></form>`
            : ''
        }</td></tr>`,
      )}</table>`,
    );
  });

  app.post<{ Params: { id: string } }>('/complaints/:id/resolve', async (request, reply) => {
    try {
      const b = body(request);
      const status = z.enum(['valid', 'invalid']).parse(b['status']);
      const ok = await deps.db.transaction((tx) =>
        resolveComplaint(tx, {
          complaintId: request.params.id,
          status,
          by: staffActor(request.staff ?? ''),
          notes: (b['notes'] ?? '').trim() === '' ? null : (b['notes'] ?? '').trim(),
          at: deps.clock(),
        }),
      );
      return await done(reply, '/complaints', ok, ok ? `Marked ${status}.` : 'Already decided.');
    } catch (error) {
      return await done(reply, '/complaints', false, problem(error));
    }
  });

  // ---- disputes (E-62) --------------------------------------------------------------------------

  app.get('/disputes', async (request, reply) => {
    const rows = await deps.db
      .select({
        id: schema.outcomeDisputes.id,
        tenant: schema.tenants.name,
        status: schema.outcomeDisputes.status,
        reason: schema.outcomeDisputes.reason,
        openedAt: schema.outcomeDisputes.openedAt,
      })
      .from(schema.outcomeDisputes)
      .innerJoin(schema.tenants, eq(schema.tenants.id, schema.outcomeDisputes.tenantId))
      .orderBy(
        sql`${schema.outcomeDisputes.status} = 'open' desc`,
        desc(schema.outcomeDisputes.openedAt),
      )
      .limit(200);
    return render(
      reply,
      request,
      'Disputes',
      h`<table><tr><th>Opened</th><th>Tenant</th><th>Status</th><th>Reason</th></tr>
      ${rows.map((d) => h`<tr><td><a href="/disputes/${d.id}">${when(d.openedAt)}</a></td><td>${d.tenant}</td><td>${badge(d.status, d.status === 'open' ? 'warn' : '')}</td><td>${d.reason}</td></tr>`)}</table>`,
    );
  });

  app.get<{ Params: { id: string } }>('/disputes/:id', async (request, reply) => {
    const [d] = await deps.db
      .select({
        id: schema.outcomeDisputes.id,
        tenantId: schema.outcomeDisputes.tenantId,
        status: schema.outcomeDisputes.status,
        reason: schema.outcomeDisputes.reason,
        resolution: schema.outcomeDisputes.resolution,
        outcome: schema.callOutcomes.outcome,
        confidence: schema.callOutcomes.confidence,
        extracted: schema.callOutcomes.extracted,
        billedAt: schema.callOutcomes.billedAt,
        attemptId: schema.callAttempts.id,
        answeredBy: schema.callAttempts.answeredBy,
        answeredAt: schema.callAttempts.answeredAt,
        endedAt: schema.callAttempts.endedAt,
        humanSpeechSec: schema.callAttempts.humanSpeechSec,
        aiDisclosedAt: schema.callAttempts.aiDisclosedAt,
        recordingDisclosedAt: schema.callAttempts.recordingDisclosedAt,
        endReason: schema.callAttempts.endReason,
        transcriptUri: schema.callAttempts.transcriptUri,
        charged: schema.billingLedger.totalMinor,
        currency: schema.billingLedger.currency,
        provider: schema.billingLedger.provider,
      })
      .from(schema.outcomeDisputes)
      .innerJoin(schema.callOutcomes, eq(schema.callOutcomes.id, schema.outcomeDisputes.outcomeId))
      .innerJoin(schema.callAttempts, eq(schema.callAttempts.id, schema.callOutcomes.attemptId))
      .leftJoin(
        schema.billingLedger,
        eq(schema.billingLedger.id, schema.callOutcomes.billingLedgerId),
      )
      .where(eq(schema.outcomeDisputes.id, request.params.id))
      .limit(1);
    if (d === undefined) return reply.code(404).send('not found');
    let transcript: Raw = h`<p class="muted">No transcript stored.</p>`;
    if (d.transcriptUri !== null) {
      if (deps.readTranscript === null)
        transcript = h`<p class="muted">Transcript storage is not configured here.</p>`;
      else {
        // Reading evidence is an audited access, the same as a merchant playing it (E-74).
        await audit(deps.db, {
          tenantId: d.tenantId,
          actorType: 'user',
          actorId: staffActor(request.staff ?? ''),
          action: 'transcript.accessed',
          targetType: 'call_attempt',
          targetId: d.attemptId,
          after: { purpose: 'dispute_review', dispute_id: d.id },
        });
        const turns = await deps.readTranscript(d.transcriptUri).catch(() => null);
        transcript =
          turns === null
            ? h`<p class="muted">Transcript could not be read.</p>`
            : h`<ol>${turns.map((t) => h`<li><strong>${t.role}:</strong> ${t.text}</li>`)}</ol>`;
      }
    }
    const extracted = (d.extracted ?? {}) as Record<string, unknown>;
    const facts = [
      'outcome',
      'cancel_reason',
      'reschedule_date',
      'quantity_change',
      'pincode_confirmed',
    ]
      .filter((k) => extracted[k] !== undefined)
      .map((k) => h`<li>${k}: ${String(extracted[k])}</li>`);
    return render(
      reply,
      request,
      `Dispute ${d.id}`,
      h`<div class="card"><p><strong>Merchant says:</strong> ${d.reason}</p>
      <p>Outcome ${badge(explainOutcome(d.outcome).label)} · confidence ${d.confidence} · charged ${d.charged === null ? '—' : `${(Number(d.charged) / 100).toFixed(2)} ${d.currency ?? ''}`} via ${d.provider ?? '—'} · billed ${when(d.billedAt)}</p>
      <p>Answered by <strong>${d.answeredBy ?? 'unknown'}</strong> at ${when(d.answeredAt)} · human speech ${d.humanSpeechSec ?? '—'} s · ended ${when(d.endedAt)} (${d.endReason ?? '—'})</p>
      <p>AI disclosure ${when(d.aiDisclosedAt)} · recording disclosure ${when(d.recordingDisclosedAt)}</p>
      <ul>${facts}</ul></div>
      <h2>Transcript</h2><div class="card">${transcript}</div>
      ${
        d.status === 'open'
          ? h`<h2>Decision</h2><form method="post" action="/disputes/${d.id}/resolve" class="card">
          <select name="decision"><option value="rejected">Reject — the call met the billable definition</option><option value="accepted">Accept — credit the charge</option></select><br><br>
          <textarea name="resolution" rows="3" cols="80" required minlength="10" placeholder="Why, quoting the transcript. For Shopify merchants, refund in the Partner Dashboard and note the reference here."></textarea><br><br>
          <button>Record decision</button></form>`
          : h`<div class="card">Decided: ${badge(d.status)} ${d.resolution ?? ''}</div>`
      }`,
    );
  });

  app.post<{ Params: { id: string } }>('/disputes/:id/resolve', async (request, reply) => {
    const back = `/disputes/${encodeURIComponent(request.params.id)}`;
    try {
      const b = body(request);
      const decision = z.enum(['accepted', 'rejected']).parse(b['decision']);
      const r = await deps.db.transaction((tx) =>
        resolveDispute(tx, {
          disputeId: request.params.id,
          decision,
          by: staffActor(request.staff ?? ''),
          resolution: b['resolution'] ?? '',
          at: deps.clock(),
        }),
      );
      return await done(
        reply,
        back,
        true,
        decision === 'accepted'
          ? `Accepted; credit ${r.creditLedgerId ?? '(nothing was charged)'} written. Shopify merchants: refund in the Partner Dashboard.`
          : 'Rejected.',
      );
    } catch (error) {
      return await done(reply, back, false, problem(error));
    }
  });

  // ---- erasure and DNC (requests that reach dnc@ / privacy@) -------------------------------------------

  app.get('/privacy', async (request, reply) => {
    const rows = await deps.db
      .select({
        id: schema.erasureRequests.id,
        tenantId: schema.erasureRequests.tenantId,
        source: schema.erasureRequests.source,
        status: schema.erasureRequests.status,
        dueAt: schema.erasureRequests.dueAt,
        error: schema.erasureRequests.error,
        requestedAt: schema.erasureRequests.requestedAt,
      })
      .from(schema.erasureRequests)
      .where(inArray(schema.erasureRequests.status, ['requested', 'in_progress', 'failed']))
      .orderBy(schema.erasureRequests.dueAt)
      .limit(200);
    const now = deps.clock();
    return render(
      reply,
      request,
      'Erasure & do-not-call',
      h`<div class="card"><h2>File an erasure (verified data principal)</h2>
      <form method="post" action="/privacy/erasure"><input name="phone" required placeholder="phone"> <input name="region" value="IN" size="3">
      <input name="reference" placeholder="ticket / email reference" size="30"><br><br>
      <label><input type="checkbox" name="verified" required> I verified the requester controls this number (erasure-request.md).</label><br><br>
      <button class="danger">Erase across every tenant</button></form></div>
      <div class="card"><h2>Add to the global do-not-call list</h2>
      <form method="post" action="/privacy/dnc"><input name="phone" required placeholder="phone"> <input name="region" value="IN" size="3"> <input name="reference" placeholder="dnc@ ticket" size="30"> <button>Block for every business</button></form></div>
      <h2>Open erasure requests</h2>
      <table><tr><th>Requested</th><th>Scope</th><th>Source</th><th>Status</th><th>Due</th></tr>
      ${rows.map(
        (
          e,
        ) => h`<tr><td>${when(e.requestedAt)}</td><td>${e.tenantId ?? 'all tenants'}</td><td>${e.source}</td><td>${badge(e.status, e.status === 'failed' ? 'bad' : '')} <span class="muted">${e.error ?? ''}</span></td>
        <td>${e.dueAt.getTime() < now.getTime() ? badge(when(e.dueAt), 'bad') : when(e.dueAt)}</td></tr>`,
      )}</table>`,
    );
  });

  app.post('/privacy/erasure', async (request, reply) => {
    try {
      const b = body(request);
      if (b['verified'] !== 'on')
        throw new NaaradhError('VALIDATION_FAILED', 'confirm the requester was verified');
      const phoneHash = phoneHashOf(deps.hashKey, b['phone'] ?? '', b['region'] ?? 'IN');
      const now = deps.clock();
      const id = newId('erasure');
      await deps.db.transaction(async (tx) => {
        // tenant_id NULL: the erasure worker scrubs every tenant holding the number.
        await tx.insert(schema.erasureRequests).values({
          id,
          tenantId: null,
          phoneHash,
          source: 'email',
          externalRef: (b['reference'] ?? '').slice(0, 200) || null,
          requestedAt: now,
          dueAt: addDays(now, ERASURE_COMPLETION_TARGET_DAYS),
        });
        await audit(tx, {
          tenantId: null,
          actorType: 'user',
          actorId: staffActor(request.staff ?? ''),
          action: 'erasure.requested',
          targetType: 'erasure_request',
          targetId: id,
        });
      });
      return await done(
        reply,
        '/privacy',
        true,
        `Erasure ${id} queued; the retention worker completes it.`,
      );
    } catch (error) {
      return await done(reply, '/privacy', false, problem(error));
    }
  });

  app.post('/privacy/dnc', async (request, reply) => {
    try {
      const b = body(request);
      const phoneHash = phoneHashOf(deps.hashKey, b['phone'] ?? '', b['region'] ?? 'IN');
      const r = await deps.db.transaction(async (tx) => {
        const s = await suppress(tx, {
          scope: 'global',
          phoneHash,
          purpose: 'all',
          reason: 'self_service',
          at: deps.clock(),
          notes: `dnc@ ${(b['reference'] ?? '').slice(0, 100)}`,
          createdBy: staffActor(request.staff ?? ''),
        });
        await audit(tx, {
          tenantId: null,
          actorType: 'user',
          actorId: staffActor(request.staff ?? ''),
          action: 'dnc.requested',
          targetType: 'phone_hash',
          targetId: phoneHash,
          after: { via: 'console' },
        });
        return s;
      });
      return await done(
        reply,
        '/privacy',
        true,
        r.created ? 'Blocked for every business.' : 'Already blocked.',
      );
    } catch (error) {
      return await done(reply, '/privacy', false, problem(error));
    }
  });

  // ---- kill switches (invariant 12) -------------------------------------------------------------

  app.get('/kill-switches', async (request, reply) => {
    const rows = await deps.db
      .select()
      .from(schema.killSwitches)
      .orderBy(desc(schema.killSwitches.setAt));
    return render(
      reply,
      request,
      'Kill switches',
      h`<p class="muted">Dispatch reads these from Redis every ~5 s (global → engine → tenant → campaign; inbound: * → tenant). The table is the durable record.</p>
      <form method="post" action="/kill-switches" class="card"><select name="scope"><option>global</option><option>engine</option><option>tenant</option><option>campaign</option><option>inbound</option></select>
      <input name="key" required placeholder="* | engine name | ten_… | cmp_…" size="30"> <select name="active"><option value="true">ON (stop)</option><option value="false">OFF (resume)</option></select>
      <input name="reason" required minlength="10" placeholder="reason" size="40"> <button class="danger">Flip</button></form>
      <table><tr><th>Scope</th><th>Key</th><th>State</th><th>Reason</th><th>By</th><th>At</th></tr>
      ${rows.map((k) => h`<tr><td>${k.scope}</td><td><code>${k.key}</code></td><td>${k.active ? badge('ON', 'bad') : badge('off')}</td><td>${k.reason ?? ''}</td><td>${k.setBy}</td><td>${when(k.setAt)}</td></tr>`)}</table>`,
    );
  });

  app.post('/kill-switches', async (request, reply) => {
    const b = body(request);
    const back =
      typeof request.headers.referer === 'string' && request.headers.referer.startsWith(deps.origin)
        ? new URL(request.headers.referer).pathname
        : '/kill-switches';
    try {
      const scope = z.enum(['global', 'engine', 'tenant', 'campaign', 'inbound']).parse(b['scope']);
      const key = (b['key'] ?? '').trim();
      const valid =
        scope === 'global'
          ? key === '*'
          : scope === 'engine'
            ? /^[a-z0-9_-]{2,40}$/.test(key)
            : scope === 'tenant'
              ? /^ten_[0-9A-Z]{26}$/.test(key)
              : scope === 'campaign'
                ? /^cmp_[0-9A-Z]{26}$/.test(key)
                : key === '*' || /^ten_[0-9A-Z]{26}$/.test(key);
      if (!valid) throw new NaaradhError('VALIDATION_FAILED', `invalid key for scope ${scope}`);
      const active = b['active'] === 'true';
      const reason = Reason.parse(b['reason']);
      const by = staffActor(request.staff ?? '');
      await deps.db.transaction(async (tx) => {
        await tx
          .insert(schema.killSwitches)
          .values({ scope, key, active, reason, setBy: by, setAt: deps.clock() })
          .onConflictDoUpdate({
            target: [schema.killSwitches.scope, schema.killSwitches.key],
            set: { active, reason, setBy: by, setAt: deps.clock() },
          });
        await audit(tx, {
          tenantId: /^ten_/.test(key) ? key : null,
          actorType: 'user',
          actorId: by,
          action: 'kill_switch.flipped',
          targetType: 'kill_switch',
          targetId: `${scope}:${key}`,
          after: { active, reason },
        });
      });
      // Durable first, then the hot copy the dispatcher reads.
      try {
        await setKillSwitch(deps.redis, scope, key, active);
      } catch (error) {
        request.log.error({ err: error, scope }, 'kill switch recorded but Redis update failed');
        return await done(
          reply,
          back,
          false,
          'Recorded in the database but Redis did not update — retry now; see kill-switch.md.',
        );
      }
      return await done(reply, back, true, `${scope}:${key} is ${active ? 'ON' : 'off'}.`);
    } catch (error) {
      return await done(reply, back, false, problem(error));
    }
  });

  registerNumberRoutes(app, deps);
  registerMerchantRoutes(app, deps);

  return app;
}
