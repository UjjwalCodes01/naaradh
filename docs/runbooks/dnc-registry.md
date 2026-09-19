# National do-not-call lists — loading, freshness, refusals (P6-CMP-1)

**Symptom:** marketing calls to US or UK customers are refused `dnd:unknown` ("DND check unavailable") across every merchant, or the reminder to reload a list is due.

## What the system does on its own

- Before a **promotional** call to a region in `DND_REGISTRY_REGIONS` (production: `US` in prod-us, `GB` in prod-eu), the gate asks the loaded registry (`registryDndProvider`): the number's hash is looked up in `dnc_registry_entries`. No customer number leaves Naaradh to be screened, and no registry number is stored in the clear.
- It **fails closed** — `dnd:unknown`, retried every 15 minutes, never dialled — when a required list (`us_national`, `uk_tps`) was never loaded, when the last complete load is older than the law allows (US 31 days, UK TPS 28), when a US subscription covers only some area codes and not this number's, or when an optional list that was loaded (a state list, CTPS) has gone stale.
- Every other non-Indian region has no list yet (Q-32): its marketing calls are refused the same way. Transactional calls are not screened unless the tenant flag `dnd.scrub_transactional` is on.

## Confirm

```sql
select list, region, active_version, loaded_at, max_age_days, area_codes,
       now() - loaded_at as age
from dnc_registry_lists order by region, list;
```

A row with `active_version` null, or `age` past `max_age_days`, is the cause.

## Load a list

The file holds real people's numbers. It never goes into the repo, a ticket, a chat or a log.

1. On the trusted machine used for key rotations ([`secret-rotation.md`](secret-rotation.md) — full-disk encryption, your own gcloud login), download the current file from the registry's own portal (US: telemarketing.donotcall.gov with the SAN; UK: the TPS licence portal).
2. Run the loader against the region's database:

   ```bash
   DATABASE_SERVICE_URL=$(gcloud secrets versions access latest --secret DATABASE_SERVICE_URL --project naaradh-prod-us) \
   PHONE_HASH_KEY=$(gcloud secrets versions access latest --secret PHONE_HASH_KEY --project naaradh-prod-us) \
   DNC_LIST=us_national DNC_VERSION=2026-09-19 DNC_DOWNLOADED_AT=2026-09-19 \
   DNC_FILE=/secure/path/us-dnc.txt \
   pnpm --filter @naaradh/workers dnc:load
   ```

   | Variable | Value |
   |---|---|
   | `DNC_LIST` | `us_national`, `us_state_<xx>`, `uk_tps` or `uk_ctps` |
   | `DNC_VERSION` | the file's date, e.g. `2026-09-19` |
   | `DNC_DOWNLOADED_AT` | the day you downloaded it — the 31/28-day clock starts here, not at the load; a download already past the limit is refused |
   | `DNC_FILE` | the local path — or `gs://bucket/object` if the file sits in a private, CMEK bucket in the same project (none is provisioned by Terraform yet) |
   | `DNC_AREA_CODES` | US partial subscription only, e.g. `201,212,646` — omit for all area codes |

   The built image carries the same entrypoint (`node dist/dnc-load.js`) for running it as a one-off Cloud Run Job instead.
3. The loader writes the new version beside the old one and switches only when every line is in; an empty or unreadable file is refused and the previous version stays active. It prints counts only.
4. Verify with the query above: `active_version` is the new one, `age` is minutes. Then delete the downloaded file.

## Cadence

Put a calendar reminder at **25 days** for both lists (the US deadline is 31, the TPS 28). A missed reload stops marketing calls in that country; it never lets an unscreened call through.

## Do not

- Do not set `DND_REGISTRY_REGIONS` empty to "unblock" calls — that removes screening, and marketing calls would then be refused `dnd:unknown` by the fallback anyway. Load the list.
- Do not edit `dnc_registry_entries` by hand; the application role cannot, and the service role should not.
