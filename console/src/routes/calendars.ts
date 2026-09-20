import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { CALENDAR_PROVIDERS } from '@naaradh/calendar';
import {
  CalendarInput,
  createCalendar,
  listCalendars,
  setCalendarStatus,
  upcomingAppointments,
} from '@naaradh/pipeline';
import { badge, h, when } from '../html.js';
import { Reason, body, done, problem, render, staffActor, type ConsoleDeps } from '../support.js';

/**
 * Calendars (ADR-0011 §5). Staff work, like numbers and the DLT link: a provider credential is
 * involved and Naaradh stores only its Secret Manager reference. Runbook:
 * docs/runbooks/appointments.md; the credential itself is created by a human per
 * docs/go-live/09-appointments.md.
 */
export function registerCalendarRoutes(app: FastifyInstance, deps: ConsoleDeps): void {
  app.get<{ Querystring: { tenant?: string } }>('/calendars', async (request, reply) => {
    const tenantId = (request.query.tenant ?? '').trim();
    if (tenantId === '')
      return render(
        reply,
        request,
        'Calendars',
        h`<p class="muted">Open a merchant and use their Calendars card, or pass <code>?tenant=ten_…</code>.</p>
        <p><a href="/tenants">Tenants →</a></p>`,
      );
    const [calendars, appointments] = await Promise.all([
      listCalendars(deps.db, tenantId),
      upcomingAppointments(deps.db, tenantId, deps.clock(), 50),
    ]);
    return render(
      reply,
      request,
      'Calendars',
      h`<p class="muted">The agent offers only times the provider returns. A disabled or erroring calendar means the agent offers a callback instead — never a guessed time.</p>
      <h2>Connected calendars</h2>
      <table><tr><th>Name</th><th>Provider</th><th>Event type</th><th>Slot</th><th>Status</th><th>Action</th></tr>
      ${calendars.map(
        (c) => h`<tr><td>${c.name}<div class="muted"><code>${c.id}</code> · ${c.timezone}</div></td>
        <td>${c.provider}${c.hasCredential ? '' : h` ${badge('no credential', 'warn')}`}</td>
        <td><code>${c.externalId}</code></td><td>${String(c.slotMinutes)} min</td>
        <td>${badge(c.status, c.status === 'active' ? 'good' : c.status === 'error' ? 'bad' : '')}
          ${c.lastError === null ? '' : h`<div class="muted">${c.lastError}</div>`}</td>
        <td><form method="post" action="/calendars/${c.id}/status" class="inline">
          <input type="hidden" name="tenant" value="${tenantId}">
          <input type="hidden" name="status" value="${c.status === 'active' ? 'disabled' : 'active'}">
          <input name="reason" size="24" required minlength="10" placeholder="reason">
          <button class="${c.status === 'active' ? 'danger' : ''}">${c.status === 'active' ? 'Disable' : 'Enable'}</button>
        </form></td></tr>`,
      )}</table>
      <h2>Connect a calendar</h2>
      <form method="post" action="/calendars" class="card">
        <input type="hidden" name="tenant" value="${tenantId}">
        <p><label>Provider <select name="provider">${CALENDAR_PROVIDERS.map((p) => h`<option value="${p}">${p}</option>`)}</select></label>
          <label style="margin-left:12px">Name the agent says <input name="name" size="24" required placeholder="Blood test"></label></p>
        <p><label>Event type / calendar id <input name="external_id" size="24" required placeholder="123456"></label>
          <label style="margin-left:12px">Time zone <input name="timezone" size="18" value="Asia/Kolkata" required></label>
          <label style="margin-left:12px">Slot minutes <input name="slot_minutes" type="number" min="5" max="480" value="30"></label></p>
        <p><label>Credential reference <input name="credentials_secret_ref" size="48" placeholder="sm://projects/…/secrets/calcom-ten_… (blank for a manual diary)"></label></p>
        <p><label>Provider config (JSON) <input name="config" size="60" value="{}" placeholder='{"eventTypeId":123456,"attendeeEmail":"appointments@merchant.example"}'></label></p>
        <p class="muted">Never paste the API key here — put it in Secret Manager and paste its reference. Cal.com needs <code>attendeeEmail</code>: providers require an email and Naaradh asks customers for none.</p>
        <button>Connect</button>
      </form>
      <h2>Next appointments (50)</h2>
      <table><tr><th>When</th><th>Service</th><th>Source</th><th>Status</th><th>Reminder call</th></tr>
      ${appointments.map(
        (a) => h`<tr><td>${when(a.startsAt)}<div class="muted">${a.timezone}</div></td>
        <td>${a.service ?? '—'}<div class="muted"><code>${a.ref}</code></div></td><td>${a.source}</td>
        <td>${badge(a.status, a.status === 'cancelled' ? 'warn' : a.status === 'confirmed' ? 'good' : '')}
          ${a.providerError === null ? '' : h`<div class="muted">provider: ${a.providerError}</div>`}</td>
        <td>${a.intentId === null ? (a.reminderDecidedAt === null ? h`<span class="muted">not due yet</span>` : h`<span class="muted">decided, no call</span>`) : h`<code>${a.intentId}</code>`}</td></tr>`,
      )}</table>`,
    );
  });

  app.post('/calendars', async (request, reply) => {
    const b = body(request);
    const tenantId = (b['tenant'] ?? '').trim();
    const back = `/calendars?tenant=${encodeURIComponent(tenantId)}`;
    try {
      const config = z
        .record(z.union([z.string(), z.number(), z.boolean()]))
        .parse(JSON.parse((b['config'] ?? '{}').trim() === '' ? '{}' : (b['config'] ?? '{}')));
      const input = CalendarInput.parse({
        provider: b['provider'],
        external_id: b['external_id'],
        name: b['name'],
        timezone: b['timezone'],
        slot_minutes: Number(b['slot_minutes'] ?? '30'),
        credentials_secret_ref:
          (b['credentials_secret_ref'] ?? '').trim() === ''
            ? null
            : (b['credentials_secret_ref'] ?? '').trim(),
        config,
      });
      await deps.db.transaction((tx) =>
        createCalendar(tx, {
          ...input,
          tenantId,
          by: staffActor(request.staff ?? ''),
          at: deps.clock(),
        }),
      );
      return await done(reply, back, true, 'Connected. The agent can offer its times now.');
    } catch (error) {
      return await done(reply, back, false, problem(error));
    }
  });

  app.post<{ Params: { id: string } }>('/calendars/:id/status', async (request, reply) => {
    const b = body(request);
    const tenantId = (b['tenant'] ?? '').trim();
    const back = `/calendars?tenant=${encodeURIComponent(tenantId)}`;
    try {
      const status = z.enum(['active', 'disabled']).parse(b['status']);
      const reason = Reason.parse(b['reason']);
      const ok = await deps.db.transaction((tx) =>
        setCalendarStatus(tx, {
          tenantId,
          calendarId: request.params.id,
          status,
          by: staffActor(request.staff ?? ''),
          reason,
          at: deps.clock(),
        }),
      );
      return await done(reply, back, ok, ok ? `Calendar ${status}.` : 'Calendar not found.');
    } catch (error) {
      return await done(reply, back, false, problem(error));
    }
  });
}
