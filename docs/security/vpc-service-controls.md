# VPC Service Controls for `naaradh-prod-in` — evaluation (P3-INF-7)

**For:** the founder. **Decision needed:** whether to put a VPC Service Controls (VPC-SC) perimeter around the production project now (SPEC §6.4: "perimeter around prod project once stable `[VERIFY complexity/cost]`").

**Recommendation in one line:** not yet. The perimeter would protect the smaller half of our data at a real, recurring operational cost for a one-person team; the controls already in place cover the threats it addresses best. Revisit under the conditions in §6.

## 1. What VPC-SC is

A perimeter is a list of Google APIs ("restricted services") for one or more projects. Requests to those APIs succeed only if they originate *inside* the perimeter (a VPC in a member project) or match an explicit ingress rule (identity + access level such as an IP range or managed device). Data cannot be copied from a restricted service to a project outside the perimeter unless an egress rule allows it. It is an API-level boundary, not a network firewall: it stops a valid, stolen credential from being used *from outside*, and stops an insider from copying data *to outside*. It does nothing about an attacker who is already running inside the perimeter (a compromised Cloud Run service reads the same secrets it always could).

## 2. What a perimeter around prod would protect

| Data / service | Today | With a perimeter |
|---|---|---|
| **Secret Manager** — DB URLs, `PHONE_ENC_PRIVATE_KEY`, `STAFF_ENC_PRIVATE_KEY`, engine keys | Per-secret IAM to each service's own SA only (the key-holder map in `infra/locals.tf`, plan-time guarded); no project-level accessor | A leaked SA token or an over-granted human could not read a secret from a laptop or another project |
| **Recordings bucket** (`<project>-recordings`) | CMEK, uniform bucket-level access, public access prevention enforced, readers sign V4 URLs as themselves, access audited in `access_log` (AGENTS.md §11), Data Access audit logs (P3-INF-5) | Bucket unreadable from outside the perimeter even with a valid credential; `gsutil cp` to a personal project denied |
| **BigQuery** `naaradh_analytics` | CMEK, no PII by design (coarse pincode band only), one exporter SA | Query results could not be saved to a table outside the perimeter |
| **Cloud KMS** keys | Per-key grants to the GCS / BigQuery service agents only; `prevent_destroy` | Keys unusable from outside |
| Also inside: Cloud Logging + the new audit bucket, Pub/Sub, Artifact Registry, Cloud Run admin API | Audit logs land in a locked bucket (P3-INF-5) | Exfiltration of logs / images blocked |

What it does **not** protect: **Postgres**, which is the system of record and holds every phone hash, ciphertext, consent row and transcript pointer. It is on Neon (ADR-0004), outside Google Cloud, reached over public TLS from the Cloud NAT static IPs with an IP allow-list. A perimeter has no effect on it either way. In terms of sensitivity this is well over half of what an attacker would want.

## 3. What it breaks or complicates in this architecture

1. **Every human operation is done from a laptop** (`docs/runbooks/deploy.md`: Terraform apply, `gcloud secrets versions add`, Logs Explorer, pulling dead letters, BigQuery queries, rotating keys). All of these call restricted services from outside the perimeter and would be denied unless the person matches an access level. Access levels are IP-range based or device based (Chrome Enterprise Premium / BeyondCorp, a paid product). A founder on a residential ISP with a changing IP has no clean IP-based level; the workable alternatives are a fixed-IP VPN egress, a jump VM inside the VPC, or a per-person device policy `[VERIFY]` which product tier that needs.
2. **GitHub Actions deploys through Workload Identity Federation** (`modules/iam`, `deploy.yml`, `terraform-plan.yml`). Runners have no stable IPs. The `deployer` SA pushes to Artifact Registry, updates Cloud Run services and runs the `migrate` job; the `tf-planner` SA reads state from GCS and every resource's metadata. Both need ingress rules keyed on identity (`serviceAccount:deployer@…`, `serviceAccount:tf-planner@…`) with source "any", for exactly the services they touch (`artifactregistry`, `run`, `storage`, plus whatever `plan` reads: `secretmanager` metadata, `redis`, `pubsub`, `monitoring`, `logging`, `iam`, `compute`, `certificatemanager`, `iap`, `cloudkms`, `bigquery`). Identity-only ingress from "any source" is exactly the hole a perimeter is meant to close, but it is the standard pattern for CI. The STS token exchange itself (`sts.googleapis.com`) is not a restricted service `[VERIFY]`.
3. **Recordings playback uses V4 signed URLs** that a merchant's browser fetches straight from `storage.googleapis.com` (`web`, `api`, `console`; ADR-0009). With `storage.googleapis.com` restricted, those requests come from arbitrary internet addresses and are denied unless an ingress rule admits the signing service accounts from any source for `storage.objects.get` `[VERIFY]` — which again reopens the bucket to anyone holding a valid signed URL, i.e. the status quo. Alternative: proxy media through Cloud Run (costs egress and instance time on every playback).
4. **IAP in front of the staff console** (`modules/lb`). The console itself is a Cloud Run service behind the load balancer; the browser never calls a Google API, so IAP admission is unaffected. But the console *process* calls Secret Manager and GCS from inside the VPC — fine — and staff use `iap.googleapis.com` only indirectly. Low risk, `[VERIFY]` in dry-run.
5. **Cloud Run egress through Cloud NAT** (`modules/network`, Direct VPC egress, `ALL_TRAFFIC`). Calls from services to Google APIs stay on Google's network (Private Google Access) and are "inside" the perimeter; calls to Neon, Shopify, engines, Razorpay and Postmark are not Google APIs and are untouched. This part is compatible as-is. Note that Cloud Run inside a perimeter requires the `run.allowedIngress` / VPC-egress org policies to be set consistently `[VERIFY]`.
6. **`naaradh-shared`** (Cloud DNS, later a shared registry for digest promotion, monitoring workspace) is a separate project. Either it joins the perimeter, or a perimeter bridge / egress rule is needed for DNS record writes and image pulls. Every new cross-project dependency becomes a rule change.
7. **Local development** is unaffected (dev is a separate project and would not be in the perimeter), but every Phase 6 region project (`prod-us`, `prod-eu`) repeats the whole exercise.

## 4. The rules that would be needed (minimum)

- One Access Context Manager policy at the organisation (needs `roles/accesscontextmanager.policyAdmin` on the org).
- A **regular perimeter** `naaradh-prod` containing `naaradh-prod-in`, first in **dry-run** mode, with restricted services: `secretmanager`, `storage`, `cloudkms`, `bigquery`, `logging`, `pubsub`, `artifactregistry`, `run`, `redis`, `monitoring` `[VERIFY]` each is on the supported list at the time.
- Access level `naaradh_staff`: staff Google accounts **and** (fixed office/VPN IP range **or** managed device). Without the second factor an access level keyed on identity alone is only as strong as the account's MFA, which we already require.
- Ingress rules: (a) `naaradh_staff` → all restricted services; (b) `deployer` SA from any source → `artifactregistry`, `run`, `storage` (state), `iamcredentials`; (c) `tf-planner` SA from any source → read methods of everything `plan` touches; (d) signing SAs (`run-api`, `run-web`, `run-console`) from any source → `storage.objects.get` on the recordings bucket, or the proxy alternative in §3.3; (e) Google-managed identities that write into the project (Pub/Sub dead-letter agent, the audit log sink writer, Cloud Build if ever used) `[VERIFY]` which of these need explicit rules.
- Egress rules: to `naaradh-shared` for DNS and images; to the Neon-side nothing (not a Google API).
- Org policies to pair with it: `gcp.restrictNonCmekServices`, `iam.disableServiceAccountKeyCreation`, `storage.publicAccessPrevention`, `iam.allowedPolicyMemberDomains` (domain-restricted sharing — `infra/main.tf` already assumes it is on) `[VERIFY]` which are already set on the org (`infra/README.md` documents resource-location and CMEK-for-recordings policies).

## 5. Cost

VPC Service Controls has **no price**. The cost is:

- **Time to get it right:** at least two to four weeks in dry-run mode reading `VPC_SERVICE_CONTROLS` violation logs and adding rules before enforcing; then every new integration, every new human, every new CI job and every new region is a perimeter change, applied by hand at the org level (our Terraform is per project and applied by a human — this would be a second, more dangerous apply surface).
- **Failure mode:** a wrong rule does not fail safe for us. It blocks a deploy, stops recordings playback for every merchant, or locks the only operator out of Secret Manager during an incident — all while calls continue. There is nobody else to notice.
- **A paid dependency** if device-based access levels are the only workable staff access level.

## 6. Recommendation

**Do not enable a perimeter for `naaradh-prod-in` in Phase 3.** The threats it is best at — a stolen credential used from outside, or data copied to another project — are already narrowed by controls that cost nothing to operate: no service-account keys (WIF only), per-secret IAM to per-service identities with a plan-time guard (the key-holder map), CMEK on recordings, analytics and now audit logs, uniform bucket access with public access prevention, no project-level roles for any runtime identity, IAP with MFA in front of the only staff surface, and, from P3-INF-5, Data Access logs for Secret Manager, GCS, KMS, BigQuery and IAP in a locked bucket so that misuse is at least visible. Meanwhile the perimeter would leave the database — the largest store of personal data — exactly where it is.

**Revisit when any of these is true:**

1. Postgres moves inside Google Cloud (the documented Neon → Cloud SQL Mumbai fallback, open question Q-16). Then a perimeter covers the majority of the data and the case changes.
2. There is a second operator and a fixed staff network or managed devices, so an access level can be defined without locking the company out.
3. A customer contract, the Shopify Level 2 protected-data review, or an auditor asks for it by name.
4. A **dry-run** perimeter (free, zero impact) has run for 30 days with every violation explained. If we want to start learning now, this is the only step worth taking in Phase 3: create the policy and a dry-run perimeter, route the violation logs into the audit bucket, and read them monthly.

Until then, the cheaper items on the same list matter more: the org policies in §4, the quarterly access review (SPEC §14), and rotating the engine and Shopify secrets on the runbook schedule.
