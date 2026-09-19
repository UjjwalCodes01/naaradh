#!/usr/bin/env bash
# `pnpm tf:plan ENV=stage` — read-only Terraform plan for one environment.
#
# Plan only, never apply. AGENTS.md section 1: agents produce plans; a human applies them
# (docs/runbooks/deploy.md). Uses your own gcloud application-default credentials.
#
#   ENV              dev | stage | prod-in | prod-us | prod-eu   (required)
#   TF_STATE_BUCKET  state bucket (default: naaradh-tfstate-<ENV>)
set -euo pipefail

ENV_NAME="${ENV:-}"
for arg in "$@"; do
  case "$arg" in
    ENV=*) ENV_NAME="${arg#ENV=}" ;;
  esac
done

if [[ -z "$ENV_NAME" ]]; then
  echo "usage: pnpm tf:plan ENV=<dev|stage|prod-in|prod-us|prod-eu>" >&2
  exit 2
fi

TFVARS="infra/envs/${ENV_NAME}.tfvars"
if [[ ! -f "$TFVARS" ]]; then
  echo "no such environment: ${TFVARS} (have: $(ls infra/envs | sed 's/\.tfvars$//' | tr '\n' ' '))" >&2
  exit 2
fi

BUCKET="${TF_STATE_BUCKET:-naaradh-tfstate-${ENV_NAME}}"

# -reconfigure: the same working directory is reused for several environments.
terraform -chdir=infra init -input=false -reconfigure \
  -backend-config="bucket=${BUCKET}" \
  -backend-config="prefix=naaradh/${ENV_NAME}"

# -lock=false: a plan must never block (or be blocked by) a human's apply.
terraform -chdir=infra plan -var-file="envs/${ENV_NAME}.tfvars" -input=false -lock=false
