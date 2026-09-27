# SOC 2 readiness — Trust Services Criteria against what exists

P7-OPS-1. Written 28 Sep 2026. This maps the 2017 Trust Services Criteria (revised 2022) to the
controls this repository already evidences, and lists what is missing. It is a readiness map, not
an audit: only a licensed CPA firm can issue a SOC 2 report.

**Scope proposed for the first report:** Security (the common criteria, mandatory) plus
**Availability** and **Confidentiality**. Leave Processing Integrity and Privacy out of the first
report — Privacy in particular would pull the whole DPDP/GDPR programme into audit scope before
counsel has signed it off.

**Type 1 first.** A Type 1 report says the controls are *designed* properly at one date; a Type 2
says they *operated* over a period, usually 3–12 months. Enterprise buyers ask for Type 2, but a
Type 1 is what you can show while the observation window runs.

## Where the repo is strong

The technical controls are unusually complete for this stage, because the product's invariants
already demanded them. `docs/security/checklist.md` carries the evidence row by row; the short
version:

- **Tenant isolation** enforced in the database (FORCE RLS on every tenant table, a test that no
  future table can slip through, no DELETE for the app role anywhere).
- **Encryption and key custody**: phone numbers hashed for lookup and encrypted for dialling, the
  private key held only by the services that dial; CMEK on recordings.
- **Change management** through code: every infrastructure change is a Terraform diff, deploys go
  through CI with Workload Identity Federation and no long-lived keys.
- **Audit trail**: append-only `audit_log` (a trigger refuses UPDATE and DELETE), including every
  recording played and every export of the log itself, exportable per tenant (P7-ENT-1).
- **Vulnerability management**: Dependabot, container scanning, CodeQL, gitleaks in CI.

## Criteria map

Status: **evidenced** = control exists and a file or test proves it · **partial** = built but not
yet operating (nothing is applied to Google Cloud yet) · **gap** = nothing exists yet.

### CC1 — Control environment

| Criterion | Status | Evidence / what is missing |
|---|---|---|
| CC1.1 Integrity and ethical values | gap | A code of conduct, acknowledged by everyone with access |
| CC1.2 Board oversight | gap | For a founder-led company: a quarterly security review minuted in writing |
| CC1.3 Structure, authority, responsibility | partial | Roles exist in code (`requireRole`, IAP groups); an org chart with named security owner does not |
| CC1.4 Competence | gap | Security awareness training on hire and yearly, with records |
| CC1.5 Accountability | gap | Onboarding/offboarding checklist with access grant and revoke evidence |

### CC2 — Communication and information

| Criterion | Status | Evidence / what is missing |
|---|---|---|
| CC2.1 Quality information | evidenced | Structured logs (`shared/src/logger.ts`), metrics and alerts (`infra/modules/monitoring`) |
| CC2.2 Internal communication | partial | Runbooks in `docs/runbooks/`; an information security policy that staff acknowledge is missing |
| CC2.3 External communication | evidenced | `/security`, `security.txt` (RFC 9116), `/privacy`, `/dpa`, `/subprocessors`, status page decided (go-live 10 §7) |

### CC3 — Risk assessment

| Criterion | Status | Evidence / what is missing |
|---|---|---|
| CC3.1–CC3.2 Objectives and risk identification | partial | The risk register in `PLAN.md` is product risk; a **security** risk register (asset, threat, likelihood, impact, owner, treatment) is missing |
| CC3.3 Fraud risk | partial | Toll fraud (invariant 19), bought lists (consent gate), prompt injection (E-72, E-90) are all handled in code; not yet written up as a fraud risk assessment |
| CC3.4 Change in risk | gap | A yearly risk review, and one on any new region, vendor or product line |

### CC4 — Monitoring activities

| Criterion | Status | Evidence / what is missing |
|---|---|---|
| CC4.1 Ongoing evaluation | partial | Alert policies and uptime checks in Terraform; not yet applied |
| CC4.2 Deficiency communication | partial | On-call runbook defines escalation; no record of deficiencies tracked to closure yet |

### CC5 — Control activities

| Criterion | Status | Evidence / what is missing |
|---|---|---|
| CC5.1–CC5.2 Controls and technology controls | evidenced | The compliance gate, RLS, key custody, lint rules that enforce invariants (`tools/`) |
| CC5.3 Policies and procedures | gap | The written policy set below |

### CC6 — Logical and physical access

| Criterion | Status | Evidence / what is missing |
|---|---|---|
| CC6.1 Access security | evidenced | RLS; key-holder map in Terraform; API keys stored as SHA-256 only; `__Host-` session cookie |
| CC6.2 Access provisioning | partial | Staff console behind IAP by group; the provisioning *process* is not written |
| CC6.3 Access removal / least privilege | partial | Per-service identities with least privilege in `infra/modules/iam`; offboarding checklist missing |
| CC6.4 Physical access | evidenced (inherited) | No offices or servers: Google Cloud and Neon's own SOC 2 reports cover this — collect them |
| CC6.5 Disposal | evidenced | Erasure workflow and retention jobs, tested end to end (`workers/test/int/compliance.test.ts`) |
| CC6.6 Boundary protection | evidenced | Cloud Armor, ingress restricted to the load balancer, no public buckets, SSRF guards on every outbound fetch (webhooks, recordings) |
| CC6.7 Data in transit | evidenced | TLS only (HSTS), Neon TLS required, signed webhooks both directions |
| CC6.8 Malicious software | evidenced | Container scanning, dependency scanning, no user-uploaded executables |

### CC7 — System operations

| Criterion | Status | Evidence / what is missing |
|---|---|---|
| CC7.1 Vulnerability detection | evidenced | CodeQL, Dependabot, trivy, gitleaks in CI |
| CC7.2 Anomaly monitoring | partial | Alert policies exist; applied nowhere yet |
| CC7.3–CC7.4 Incident evaluation and response | partial | `runbooks/on-call.md` and per-incident runbooks; a written **incident response policy** with severity levels and customer notification timelines is missing |
| CC7.5 Recovery | partial | Restore drill runbook and script; no drill has been run (`docs/security/restore-drills.md`) |

### CC8 — Change management

| Criterion | Status | Evidence / what is missing |
|---|---|---|
| CC8.1 Change authorisation and testing | partial | CI gates (lint, typecheck, unit, compliance, contract, integration), Terraform plan reviewed by a second person (go-live 05). **Branch protection requiring review is a repository setting, not yet evidenced** — with one engineer, document how a change is reviewed |

### CC9 — Risk mitigation

| Criterion | Status | Evidence / what is missing |
|---|---|---|
| CC9.1 Business disruption | partial | Engine failover via the adapter, circuit breakers, kill switches; a business continuity plan is missing |
| CC9.2 Vendor management | partial | `/subprocessors` lists vendors; ADR-0014 limits what engines may hold. Missing: a vendor register with each vendor's own SOC 2 / ISO report on file and a yearly review |

### A1 — Availability

| Criterion | Status | Evidence / what is missing |
|---|---|---|
| A1.1 Capacity | partial | Concurrency limits per tenant and engine, load tests scripted (`load/`) and not yet run against staging |
| A1.2 Environmental protections, backups | partial | Neon PITR, restore drill scripted and not yet run |
| A1.3 Recovery testing | gap | The first restore drill, recorded |

### C1 — Confidentiality

| Criterion | Status | Evidence / what is missing |
|---|---|---|
| C1.1 Identify and protect confidential information | evidenced | Phone encryption, CMEK recordings, PII redaction in logs, `pnpm lint:pii` |
| C1.2 Disposal | evidenced | Retention and erasure jobs, tested |

## The policy set to write

These do not exist yet. Each is short — two to four pages — and must be **approved, dated, and
acknowledged** by everyone with production access. That acknowledgement is itself audit evidence.

1. Information Security Policy (the umbrella; names the security owner)
2. Acceptable Use Policy for staff (the merchant AUP already exists; this one is for employees)
3. Access Control Policy — provisioning, quarterly review, offboarding within 24 hours
4. Change Management Policy — describe the CI gates and Terraform review that already happen
5. Incident Response Policy — severities, who decides, customer notification timelines (72 hours
   is the GDPR bar; DPDP rules may set their own — ask counsel)
6. Business Continuity and Disaster Recovery Policy — RPO 1 h / RTO 4 h are already decided (SPEC)
7. Vendor Management Policy — register, due diligence, yearly review
8. Risk Assessment Policy — yearly, and on any major change
9. Data Retention and Disposal Policy — mirror what the retention jobs already do
10. Encryption and Key Management Policy — mirror the key-holder map and rotation runbook
11. Code of Conduct, and a security awareness training record

## Sequence

1. **Now, free:** write the eleven policies from what the code already does; start the security
   risk register; collect Google Cloud's and Neon's SOC 2 reports for CC6.4 and CC9.2.
2. **At the first stage apply:** run the restore drill, the load test and the first access review
   — the three "partial" items that only need the environment to exist.
3. **When an enterprise deal needs it:** pick an auditor (a licensed CPA firm) and, optionally, a
   compliance-automation tool to collect evidence continuously. Type 1 first; start the Type 2
   observation window the same day.
4. **ISO 27001** only if a buyer asks for it by name — it overlaps SOC 2 heavily and the same
   policies carry over.
