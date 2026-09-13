# 1. Company and legal

Almost everything downstream needs a registered Indian company: telecom KYC for numbers, DLT
registration, GST invoices, Razorpay, Google Cloud billing in India, and Shopify payouts
(SPEC §3.1). Start this first; it is the longest clock you control.

## 1. Incorporate the Private Limited company

| Step | Where | Lead time | Output you need later |
|---|---|---|---|
| Company incorporation (SPICe+) | MCA portal, via your CA | 1–3 weeks | Certificate of Incorporation (CoI), CIN |
| PAN and TAN | Issued with SPICe+ | — | Company PAN (KYC everywhere) |
| GST registration | GST portal | 1–2 weeks after CoI | **GSTIN** (DLT, telecom KYC, Razorpay, invoices) |
| Current account | Any bank | ~1 week | Account for Razorpay settlements and Shopify payouts |
| MSME/Udyam (optional) | udyamregistration.gov.in | 1 day | — |
| Startup India / DPIIT (optional) | startupindia.gov.in | 2–4 weeks | Tax benefits |

What your CA will typically ask for `[CA — confirm the current list]`: identity and address proof
for each director, photographs, a Digital Signature Certificate per director, registered office
proof (utility bill + owner's NOC or rent agreement), the proposed names, and the business
objects for the MoA.

**Later, only if raising US capital:** a Delaware parent with the Indian company as a subsidiary.
Plan it with the CA and lawyer from the start; retroactive "flips" are expensive under FEMA
(SPEC §3.1). Not needed now.

## 2. Tax set-up that affects the product

- **GST 18%** on domestic SaaS invoices. Razorpay issues GST invoices once your GSTIN is on the
  Razorpay account (P2-BILL-3).
- **Export of services** (US/EU merchants, and Shopify App Store payouts, which arrive from a foreign
  entity) is zero-rated under an **LUT** — file it before the first export invoice (Q-11, `[CA]`).
- Indian merchants may deduct **TDS** on your invoices; plan cash flow for it.
- Keep FIRC/e-BRC records for Shopify payouts.

The merchant's GSTIN and PAN are collected in onboarding (dashboard Settings, Shopify app Setup)
and stored on the tenant — they are needed for the merchant's own DLT PE registration.

## 3. Trademark

File "Naaradh" (word mark, and the logo when ready) in classes **9, 35, 38, 42** at IP India
through a trademark attorney. Grant takes 12–18 months; filing date is what protects you, so file
now (P0-LEG-5).

## 4. Lawyer scope

Engage a TMT/telecom + data-protection lawyer for a **scoped written opinion** (P0-LEG-4) on:

1. The number series a non-BFSI business may use for AI service calls (Q-01), with the TSP letters.
2. Telemarketer liability — who is telemarketer-of-record on a vendor's numbers (Q-05), and the
   merchant's vicarious liability as Principal Entity (SPEC §3.3).
3. Inbound: obligations when an AI **answers** calls on a virtual number, and the transfer leg (Q-15).
4. DPDP: Naaradh as processor; breach timelines (Q-06); whether a database in Singapore is
   acceptable (Q-16).
5. Consent wording for checkout (Q-08) and for the website snippet.
6. Review of the public legal pages (below).

## 5. Legal documents the product already links to

Drafts are live in the dashboard app (`apps/web/src/content/legal.ts`) and show a "pending review
by counsel" notice. They describe what the code actually does; when the lawyer changes wording,
edit that file (and keep it true to the code).

| Page | URL | Status |
|---|---|---|
| Privacy Policy | `/privacy` | draft — names Neon (Singapore) and GCS (Mumbai) |
| Terms of Service | `/terms` | draft — liability/indemnity/governing law left for counsel |
| Data Processing Agreement | `/dpa` | draft |
| Acceptable Use Policy | `/aup` | draft |
| Sub-processors | `/subprocessors` | draft — **add the chosen engine and telephony provider** after ADR-0001 |
| Refunds and disputes | `/refunds` | draft |
| Grievance Officer (DPDP) | `/grievance` | draft — **name and designation needed** |
| Security, Cookies, Contact | `/security`, `/cookies`, `/contact` | final wording |
| Do-not-call form | `/do-not-call` | working |

Still to write (SPEC §13): merchant compliance attestation text (a version exists in the Shopify
app — `MERCHANT_ATTESTATION` in `packages/pipeline/src/billing/shopify-subscribe.ts`), consent
wording templates per language, SLA for Scale/Enterprise, employee/contractor NDA and
data-handling policy, and an **incident response plan** (required for Shopify Level 2).

## 6. People and roles to name

- **Grievance Officer** (DPDP) — a named person; published at `/grievance`, reachable at
  privacy@naaradh.com.
- **Staff with console access** — Google accounts in a group allowed through IAP (see
  [05](05-cloud-infrastructure.md#8-staff-console-access-iap)).
- **Production approvers** — reviewers of the GitHub `production` environment.
