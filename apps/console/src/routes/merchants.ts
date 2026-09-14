import type { FastifyInstance } from 'fastify';
import {
  DIRECT_USE_CASES,
  DirectTenantInput,
  DltLinkInput,
  createDirectTenant,
  setDltLink,
} from '@naaradh/pipeline';
import { h } from '../html.js';
import { body, done, problem, render, type ConsoleDeps } from '../support.js';

/**
 * Direct merchants (API / website integrations that do not install the Shopify app) are created
 * here by staff; Shopify stores provision themselves on install (ADR-0009 §8). The DLT link is
 * also recorded here: only staff may assert that a merchant's principal entity authorised
 * Naaradh on the DLT portal (SPEC §3.3), and promotional calling stays off until they do.
 */

const opt = (v: string | undefined): string | undefined => {
  const t = (v ?? '').trim();
  return t === '' ? undefined : t;
};

export function registerMerchantRoutes(app: FastifyInstance, deps: ConsoleDeps): void {
  const dashboardUrl = deps.dashboardUrl ?? 'http://localhost:3000';

  app.get('/tenants/new', async (request, reply) =>
    render(
      reply,
      request,
      'New merchant',
      h`<p class="muted">For merchants that integrate by API or website snippet. Shopify stores are created by installing the app — do not create them here.</p>
      <div class="card"><form method="post" action="/tenants">
        <p><label>Brand name <input name="name" required minlength="2" size="30"></label>
        <label>Legal name <input name="legal_name" size="40"></label></p>
        <p><label>Country <input name="country" value="IN" size="3" maxlength="2"></label>
        <label>Time zone <input name="timezone" value="Asia/Kolkata" size="18"></label>
        <label>Currency <input name="currency" value="INR" size="4" maxlength="3"></label></p>
        <p><label>GSTIN <input name="gstin" size="18" placeholder="optional"></label>
        <label>PAN <input name="pan" size="12" placeholder="optional"></label></p>
        <p><label>Owner email <input name="owner_email" type="email" required size="32"></label>
        <label>Owner name <input name="owner_name" size="24"></label></p>
        <p>Use cases to set up (all start OFF, with draft scripts to approve):
        ${DIRECT_USE_CASES.map(
          (u) =>
            h`<label style="margin-left:10px"><input type="checkbox" name="usecase_${u}" value="on" ${u === 'cod_confirm' ? 'checked' : ''}> ${u}</label>`,
        )}</p>
        <p><label>Default script language <select name="default_locale"><option value="hi-IN">Hinglish (hi-IN)</option><option value="en-IN">English (en-IN)</option></select></label></p>
        <p><label>Why this merchant is created by hand <input name="note" size="70" required minlength="10" placeholder="pilot merchant B, website leads; agreement signed 2026-09-…"></label></p>
        <button>Create merchant</button>
      </form></div>
      <p class="muted">The merchant starts in <b>pending review</b> for 7 days (capped volume, no promotional). The owner signs in at <code>${dashboardUrl}/login</code> with an emailed link; no password is created here.</p>`,
    ),
  );

  app.post('/tenants', async (request, reply) => {
    try {
      const b = body(request);
      const input = DirectTenantInput.parse({
        name: b['name'],
        legalName: opt(b['legal_name']),
        country: opt(b['country']) ?? 'IN',
        timezone: opt(b['timezone']) ?? 'Asia/Kolkata',
        currency: opt(b['currency']) ?? 'INR',
        gstin: opt(b['gstin']),
        pan: opt(b['pan']),
        ownerEmail: b['owner_email'],
        ownerName: opt(b['owner_name']),
        useCases: DIRECT_USE_CASES.filter((u) => b[`usecase_${u}`] === 'on'),
        defaultLocale: opt(b['default_locale']) ?? 'hi-IN',
        note: b['note'],
      });
      const r = await createDirectTenant(
        deps.db,
        { email: request.staff ?? '' },
        input,
        deps.clock(),
      );
      return await done(
        reply,
        `/tenants/${r.tenantId}`,
        true,
        `Created with ${r.useCasesCreated} use case(s) and ${r.scriptsCreated} draft script(s). Ask ${input.ownerEmail} to sign in at ${dashboardUrl}/login.`,
      );
    } catch (error) {
      return await done(reply, '/tenants/new', false, problem(error));
    }
  });

  app.post<{ Params: { id: string } }>('/tenants/:id/dlt', async (request, reply) => {
    const back = `/tenants/${encodeURIComponent(request.params.id)}`;
    try {
      const b = body(request);
      const input = DltLinkInput.parse({
        dltPeId: opt(b['dlt_pe_id']),
        linked: b['linked'] === 'true',
        evidence: b['evidence'],
      });
      const r = await setDltLink(
        deps.db,
        { email: request.staff ?? '' },
        request.params.id,
        input,
        deps.clock(),
      );
      return await done(
        reply,
        back,
        true,
        r.linkedAt === null
          ? 'DLT link removed; promotional calling is blocked for this merchant.'
          : 'DLT link recorded; promotional use cases may now be enabled by the merchant.',
      );
    } catch (error) {
      return await done(reply, back, false, problem(error));
    }
  });
}
