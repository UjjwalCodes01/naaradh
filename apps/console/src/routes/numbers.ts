import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { schema } from '@naaradh/db';
import {
  NUMBER_SERIES,
  NumberAssignInput,
  NumberInput,
  NumberPurposesInput,
  NumberStatusInput,
  NumberAttestationInput,
  PURPOSES,
  assignNumber,
  listNumbers,
  registerNumber,
  setNumberPurposes,
  setNumberStatus,
  setNumberAttestation,
  type NumberView,
} from '@naaradh/pipeline';
import { badge, h, when, type Raw } from '../html.js';
import { body, done, problem, render, type ConsoleDeps } from '../support.js';

/**
 * Numbers (the CLI pool and merchants' support lines). Registering, activating, retiring and
 * reassigning numbers is staff work: the app role cannot write this table (migration 0001),
 * `purpose_allowed` is set per number from the TSP's written answer (Q-01), and E-28 rotation
 * is a status change with a reason. Runbook: docs/runbooks/cli-health.md.
 */

/** Must stay equal to KNOWN_VENDORS in packages/engines/registry (the gate matches on the name). */
const ENGINES = ['simulator', 'bolna', 'omnidim', 'retell'] as const;

const CLI_MIN_ANSWER_RATE = 0.25;

const ratePct = (n: NumberView): Raw => {
  if (n.answerRate7d === null) return h`<span class="muted">no data</span>`;
  const pct = `${(n.answerRate7d * 100).toFixed(0)}%`;
  return n.answerRate7d < CLI_MIN_ANSWER_RATE ? badge(pct, 'bad') : h`${pct}`;
};

/** North America dials only from A (P6-ENG-2); elsewhere attestation is informational. */
const attestationBadge = (n: NumberView): Raw => {
  const needed = n.region === 'US' || n.region === 'CA';
  if (n.attestation === null)
    return needed ? badge('unchecked', 'bad') : h`<span class="muted">—</span>`;
  return badge(n.attestation, n.attestation === 'A' ? 'good' : needed ? 'bad' : 'warn');
};

const statusTone = (s: NumberView['status']) =>
  s === 'active' ? 'good' : s === 'warming' ? '' : s === 'suspended' ? 'warn' : 'bad';

function purposeBoxes(checked: readonly string[]): Raw {
  return h`${PURPOSES.map(
    (p) =>
      h`<label style="margin-right:10px"><input type="checkbox" name="purpose_${p}" value="on" ${checked.includes(p) ? 'checked' : ''}> ${p}</label>`,
  )}`;
}

function purposesFrom(b: Record<string, string>): string[] {
  return PURPOSES.filter((p) => b[`purpose_${p}`] === 'on');
}

const opt = (v: string): string | undefined => {
  const t = v.trim();
  return t === '' ? undefined : t;
};

export function registerNumberRoutes(app: FastifyInstance, deps: ConsoleDeps): void {
  app.get<{ Querystring: { tenant?: string } }>('/numbers', async (request, reply) => {
    const tenant = opt(request.query.tenant ?? '');
    const rows = await listNumbers(deps.db, deps.clock(), tenant);
    const low = rows.filter(
      (n) =>
        n.status === 'active' && n.answerRate7d !== null && n.answerRate7d < CLI_MIN_ANSWER_RATE,
    );
    return render(
      reply,
      request,
      tenant === undefined ? 'Numbers' : `Numbers of ${tenant}`,
      h`${
        low.length === 0
          ? ''
          : h`<div class="flash err">${low.length} active number(s) below the 25% answer rate — the gate is skipping them (E-28). Retire or rest them: cli-health.md.</div>`
      }
      <table><tr><th>Number</th><th>Region / series</th><th>Provider → engine</th><th>Purposes</th><th>Status</th><th>Attestation</th><th>Answer rate (7 d)</th><th>Calls (7 d)</th><th>Owner</th><th>Inbound</th><th>Last used</th></tr>
      ${rows.map(
        (n) => h`<tr><td><a href="/numbers/${n.id}"><code>${n.e164}</code></a></td>
        <td>${n.region} · ${n.series}</td><td>${n.provider} → ${n.engine}</td>
        <td>${n.purposeAllowed.length === 0 ? h`<span class="muted">none</span>` : n.purposeAllowed.join(', ')}</td>
        <td>${badge(n.status, statusTone(n.status))}</td><td>${attestationBadge(n)}</td><td>${ratePct(n)}</td><td>${n.attempts7d}</td>
        <td>${n.tenantId === null ? h`<span class="muted">pool</span>` : h`<a href="/tenants/${n.tenantId}">${n.tenantName ?? n.tenantId}</a>`}</td>
        <td>${n.inboundEnabled ? (n.inboundProfileName ?? n.inboundProfileId ?? 'yes') : '—'}</td>
        <td>${when(n.lastUsedAt)}</td></tr>`,
      )}</table>
      ${rows.length === 0 ? h`<p class="muted">No numbers yet.</p>` : ''}
      <h2>Register a number</h2>
      <div class="card"><form method="post" action="/numbers">
        <p><label>Number (E.164 or national) <input name="e164" required size="18" placeholder="+91…"></label>
        <label>Region <input name="region" value="IN" size="3" maxlength="2"></label>
        <label>Series <select name="series">${NUMBER_SERIES.map((s) => h`<option value="${s}">${s}</option>`)}</select></label></p>
        <p><label>Provider <input name="provider" required placeholder="exotel" size="12"></label>
        <label>Engine <select name="engine">${ENGINES.map((e) => h`<option value="${e}">${e}</option>`)}</select></label></p>
        <p>Allowed purposes (only what the TSP's letter allows — Q-01): ${purposeBoxes([])}</p>
        <p><label>Evidence note <input name="provisioning_note" size="70" placeholder="TSP letter 2026-09-xx, docs/legal/tsp-responses/<file>"></label></p>
        <p><label>Owner tenant id (blank = shared pool) <input name="tenant_id" size="32" placeholder="ten_…"></label>
        <label>Inbound profile id <input name="inbound_profile_id" size="32" placeholder="ipr_… (support line)"></label>
        <label><input type="checkbox" name="inbound_enabled" value="on"> answer inbound calls</label></p>
        <button>Register (starts as warming)</button>
      </form></div>
      <p class="muted">Numbers start <b>warming</b>; activate them from their page once the engine's inbound answer URL points at voice (docs/go-live/02-phone-numbers-and-dlt.md §5).</p>`,
    );
  });

  app.post('/numbers', async (request, reply) => {
    try {
      const b = body(request);
      const input = NumberInput.parse({
        e164: b['e164'],
        region: opt(b['region'] ?? '') ?? 'IN',
        series: b['series'],
        provider: b['provider'],
        engine: b['engine'],
        purposeAllowed: purposesFrom(b),
        provisioningNote: b['provisioning_note'] ?? '',
        tenantId: opt(b['tenant_id'] ?? ''),
        inboundProfileId: opt(b['inbound_profile_id'] ?? ''),
        inboundEnabled: b['inbound_enabled'] === 'on',
      });
      const r = await registerNumber(deps.db, { email: request.staff ?? '' }, input, deps.clock());
      return await done(reply, `/numbers/${r.id}`, true, 'Registered as warming.');
    } catch (error) {
      return await done(reply, '/numbers', false, problem(error));
    }
  });

  app.get<{ Params: { id: string } }>('/numbers/:id', async (request, reply) => {
    const [n] = (await listNumbers(deps.db, deps.clock())).filter(
      (x) => x.id === request.params.id,
    );
    if (n === undefined) return reply.code(404).send('not found');
    const profiles =
      n.tenantId === null
        ? []
        : await deps.db
            .select({
              id: schema.inboundProfiles.id,
              name: schema.inboundProfiles.name,
              status: schema.inboundProfiles.status,
            })
            .from(schema.inboundProfiles)
            .where(eq(schema.inboundProfiles.tenantId, n.tenantId));
    const next: readonly NumberView['status'][] = ['active', 'retired', 'suspended', 'warming'];
    return render(
      reply,
      request,
      n.e164,
      h`<div class="card"><code>${n.id}</code> · ${badge(n.status, statusTone(n.status))} · ${n.region} · ${n.series} · ${n.provider} → ${n.engine}
      · answer rate ${ratePct(n)} over ${n.attempts7d} calls (7 d) · last used ${when(n.lastUsedAt)}
      <div class="muted">${n.provisioningNote ?? 'no evidence note'}</div></div>
      <h2>Status</h2>
      <div class="card"><form method="post" action="/numbers/${n.id}/status">
        <select name="status">${next.map((s) => h`<option value="${s}" ${s === n.status ? 'disabled' : ''}>${s}</option>`)}</select>
        <input name="reason" size="60" required minlength="10" placeholder="Why (carrier flagged, answer rate, rested 2 weeks, …)">
        <button>Change status</button></form>
        <p class="muted">warming → active · active → retired / suspended · suspended → active / retired · retired → warming (rest, then reintroduce; the rate resets).</p></div>
      <h2>STIR/SHAKEN attestation</h2>
      <div class="card"><form method="post" action="/numbers/${n.id}/attestation">
        <p>Currently ${attestationBadge(n)}${n.attestationCheckedAt === null ? '' : h` · checked ${when(n.attestationCheckedAt)}`}.
        ${n.region === 'US' || n.region === 'CA' ? h`<b>US and Canadian customers are called only from numbers recorded as A.</b>` : ''}</p>
        <p><select name="attestation">${(['A', 'B', 'C'] as const).map((a) => h`<option value="${a}" ${a === n.attestation ? 'selected' : ''}>${a}</option>`)}<option value="">not checked</option></select>
        <input name="evidence" size="60" required minlength="10" placeholder="Test call 2026-09-xx to a handset showing A; or carrier report ref"></p>
        <button>Record attestation</button></form>
        <p class="muted">Record what a test call or the carrier's report shows — never what a vendor's documentation promises (docs/go-live/10-us-eu.md).</p></div>
      <h2>Allowed purposes</h2>
      <div class="card"><form method="post" action="/numbers/${n.id}/purposes">
        <p>${purposeBoxes(n.purposeAllowed)}</p>
        <p><label>Evidence note <input name="provisioning_note" size="70" required minlength="10" value="${n.provisioningNote ?? ''}"></label></p>
        <button>Save purposes</button></form></div>
      <h2>Owner and inbound</h2>
      <div class="card"><form method="post" action="/numbers/${n.id}/assign">
        <p><label>Owner tenant id (blank = shared pool) <input name="tenant_id" size="32" value="${n.tenantId ?? ''}"></label></p>
        <p><label>Inbound profile ${
          profiles.length === 0
            ? h`<input name="inbound_profile_id" size="32" value="${n.inboundProfileId ?? ''}" placeholder="ipr_… (set the owner first)">`
            : h`<select name="inbound_profile_id"><option value="">— none —</option>${profiles.map(
                (p) =>
                  h`<option value="${p.id}" ${p.id === n.inboundProfileId ? 'selected' : ''}>${p.name} (${p.status})</option>`,
              )}</select>`
        }</label>
        <label><input type="checkbox" name="inbound_enabled" value="on" ${n.inboundEnabled ? 'checked' : ''}> answer inbound calls</label></p>
        <p><label>Note <input name="note" size="60" required minlength="10" placeholder="support line for <merchant>, forwarding agreed on …"></label></p>
        <button>Save owner</button></form></div>
      <p class="muted"><a href="/numbers">← all numbers</a></p>`,
    );
  });

  app.post<{ Params: { id: string } }>('/numbers/:id/status', async (request, reply) => {
    const back = `/numbers/${encodeURIComponent(request.params.id)}`;
    try {
      const input = NumberStatusInput.parse({
        status: body(request)['status'],
        reason: body(request)['reason'],
      });
      const r = await setNumberStatus(
        deps.db,
        { email: request.staff ?? '' },
        request.params.id,
        input,
      );
      return await done(reply, back, true, `${r.from} → ${r.to}.`);
    } catch (error) {
      return await done(reply, back, false, problem(error));
    }
  });

  app.post<{ Params: { id: string } }>('/numbers/:id/attestation', async (request, reply) => {
    const back = `/numbers/${encodeURIComponent(request.params.id)}`;
    try {
      const b = body(request);
      const input = NumberAttestationInput.parse({
        attestation: opt(b['attestation'] ?? '') ?? null,
        evidence: b['evidence'],
      });
      await setNumberAttestation(
        deps.db,
        { email: request.staff ?? '' },
        request.params.id,
        input,
        deps.clock(),
      );
      return await done(reply, back, true, 'Attestation recorded.');
    } catch (error) {
      return await done(reply, back, false, problem(error));
    }
  });

  app.post<{ Params: { id: string } }>('/numbers/:id/purposes', async (request, reply) => {
    const back = `/numbers/${encodeURIComponent(request.params.id)}`;
    try {
      const b = body(request);
      const input = NumberPurposesInput.parse({
        purposeAllowed: purposesFrom(b),
        provisioningNote: b['provisioning_note'],
      });
      await setNumberPurposes(deps.db, { email: request.staff ?? '' }, request.params.id, input);
      return await done(reply, back, true, 'Purposes saved.');
    } catch (error) {
      return await done(reply, back, false, problem(error));
    }
  });

  app.post<{ Params: { id: string } }>('/numbers/:id/assign', async (request, reply) => {
    const back = `/numbers/${encodeURIComponent(request.params.id)}`;
    try {
      const b = body(request);
      const input = NumberAssignInput.parse({
        tenantId: opt(b['tenant_id'] ?? ''),
        inboundProfileId: opt(b['inbound_profile_id'] ?? ''),
        inboundEnabled: b['inbound_enabled'] === 'on',
        note: b['note'],
      });
      await assignNumber(deps.db, { email: request.staff ?? '' }, request.params.id, input);
      return await done(reply, back, true, 'Owner saved.');
    } catch (error) {
      return await done(reply, back, false, problem(error));
    }
  });
}
