#!/usr/bin/env bash
# Restore drill for Neon (docs/runbooks/restore-drill.md, P3-INF-3).
#
#   scripts/restore-drill.sh <ISO-8601 UTC timestamp> [--keep] [--parent <branch id>]
#   scripts/restore-drill.sh --list
#
# Creates a branch from the primary at <timestamp>, waits for its endpoint, runs verification
# queries as the migrator role, prints a summary, deletes the branch unless --keep.
# Needs: NEON_API_KEY, NEON_PROJECT_ID, curl, jq, psql. Never echoes the API key or a URL.
#
# Neon API paths [VERIFY against https://api-docs.neon.tech]: v2 as of 2026.
set -euo pipefail

API="https://console.neon.tech/api/v2"
: "${NEON_API_KEY:?NEON_API_KEY is required}"
: "${NEON_PROJECT_ID:?NEON_PROJECT_ID is required}"
DB_NAME="${NEON_DB_NAME:-naaradh}"
ROLE="${NEON_ROLE:-naaradh_migrator}"

api() { # method path [json]
  local m="$1" p="$2" body="${3:-}"
  if [ -n "$body" ]; then
    curl -fsS -X "$m" "$API$p" -H "Authorization: Bearer $NEON_API_KEY" -H 'Content-Type: application/json' -d "$body"
  else
    curl -fsS -X "$m" "$API$p" -H "Authorization: Bearer $NEON_API_KEY"
  fi
}

if [ "${1:-}" = "--list" ]; then
  api GET "/projects/$NEON_PROJECT_ID/branches" | jq -r '.branches[] | select(.name | startswith("drill-")) | "\(.id)\t\(.name)\t\(.created_at)"'
  exit 0
fi

TS="${1:?usage: restore-drill.sh <ISO-8601 UTC timestamp> [--keep] [--parent <branch id>]}"
shift
KEEP=false
PARENT=""
while [ $# -gt 0 ]; do
  case "$1" in
    --keep) KEEP=true ;;
    --parent) PARENT="$2"; shift ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
  shift
done
echo "$TS" | grep -Eq '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$' || { echo "timestamp must be like 2026-09-14T09:30:00Z" >&2; exit 2; }

START=$(date +%s)
if [ -z "$PARENT" ]; then
  PARENT=$(api GET "/projects/$NEON_PROJECT_ID/branches" | jq -r '.branches[] | select(.default == true or .primary == true) | .id' | head -n1)
fi
[ -n "$PARENT" ] || { echo "could not find the primary branch" >&2; exit 1; }
NAME="drill-$(echo "$TS" | tr -d ':' | tr 'T' '-' | tr -d 'Z')"
echo "creating branch $NAME from $PARENT at $TS"

CREATE=$(api POST "/projects/$NEON_PROJECT_ID/branches" "$(jq -nc --arg p "$PARENT" --arg n "$NAME" --arg t "$TS" \
  '{branch:{parent_id:$p,name:$n,parent_timestamp:$t},endpoints:[{type:"read_write"}]}')")
BRANCH_ID=$(echo "$CREATE" | jq -r '.branch.id')
[ -n "$BRANCH_ID" ] && [ "$BRANCH_ID" != "null" ] || { echo "branch creation failed" >&2; exit 1; }

cleanup() {
  if [ "$KEEP" = true ]; then
    echo "kept branch $BRANCH_ID ($NAME) — delete it when done: restore-drill.sh --list"
  else
    api DELETE "/projects/$NEON_PROJECT_ID/branches/$BRANCH_ID" >/dev/null && echo "deleted branch $BRANCH_ID"
  fi
}
trap cleanup EXIT

# Wait for the endpoint to be ready (a few seconds usually).
HOST=""
for _ in $(seq 1 60); do
  EP=$(api GET "/projects/$NEON_PROJECT_ID/endpoints" | jq -r --arg b "$BRANCH_ID" '.endpoints[] | select(.branch_id == $b)')
  STATE=$(echo "$EP" | jq -r '.current_state // empty')
  HOST=$(echo "$EP" | jq -r '.host // empty')
  [ "$STATE" = "active" ] || [ "$STATE" = "idle" ] && [ -n "$HOST" ] && break
  sleep 2
done
[ -n "$HOST" ] || { echo "endpoint did not become ready" >&2; exit 1; }

# The role password is read through the API (reset not needed): [VERIFY] reveal_password endpoint.
PASSWORD=$(api GET "/projects/$NEON_PROJECT_ID/branches/$BRANCH_ID/roles/$ROLE/reveal_password" | jq -r '.password')
export PGPASSWORD="$PASSWORD"
PSQL=(psql -X -q -v ON_ERROR_STOP=1 -h "$HOST" -U "$ROLE" -d "$DB_NAME" -At)

echo "verifying"
TENANTS=$("${PSQL[@]}" -c "select count(*) from tenants")
ATTEMPTS=$("${PSQL[@]}" -c "select count(*) from call_attempts")
AUDIT=$("${PSQL[@]}" -c "select count(*) from audit_log")
NEWEST=$("${PSQL[@]}" -c "select coalesce(max(at)::text, 'none') from audit_log")
RLS=$("${PSQL[@]}" -c "select relrowsecurity and relforcerowsecurity from pg_class where relname = 'call_attempts'")
MIGRATION=$("${PSQL[@]}" -c "select coalesce(max(created_at)::text, 'none') from drizzle.__drizzle_migrations" 2>/dev/null || echo "migrations table not found")
unset PGPASSWORD

END=$(date +%s)
cat <<EOF

restore drill — $TS (branch $NAME)
  tenants        $TENANTS
  call_attempts  $ATTEMPTS
  audit_log      $AUDIT   newest at: $NEWEST
  RLS on call_attempts (enabled and forced): $RLS
  latest migration applied at: $MIGRATION
  elapsed: $((END - START)) s (branch + verify)
Record this in docs/security/restore-drills.md.
EOF

[ "$RLS" = "t" ] || { echo "FAIL: row-level security is not enabled+forced on the restored branch" >&2; exit 1; }
[ "$TENANTS" -ge 1 ] || { echo "FAIL: no tenants on the restored branch" >&2; exit 1; }
