#!/usr/bin/env bash
# Deploy the marketing site (web with NAARADH_SURFACE=marketing) to one Cloud Run service.
# Run by a human (CLAUDE.md: no agent runs gcloud mutations). Safe to re-run: the first run
# creates the project, links billing, enables APIs and creates the image repository; every run
# builds the current working tree in Cloud Build and deploys it.
#
# No database, Redis, secrets or load balancer: the marketing pages need none of them.
# Scales to zero, so with no traffic it costs nothing beyond image storage.
#
#   scripts/deploy-web.sh                      # defaults below
#   PROJECT=naaradh-web-2 scripts/deploy-web.sh   # if the project id is taken
set -euo pipefail

ACCOUNT=${ACCOUNT:-aadityavton@gmail.com}
PROJECT=${PROJECT:-naaradh-web}
BILLING=${BILLING:-019877-AF3D95-373629}
# asia-south1 has no Cloud Run domain mapping (it needs a paid load balancer there); this site
# holds no customer data, so the residency rule does not apply to it.
REGION=${REGION:-asia-southeast1}

cd "$(dirname "$0")/.."
g() { gcloud --account "$ACCOUNT" --project "$PROJECT" --quiet "$@"; }

if ! gcloud --account "$ACCOUNT" projects describe "$PROJECT" >/dev/null 2>&1; then
  gcloud --account "$ACCOUNT" projects create "$PROJECT" --name naaradh
  gcloud --account "$ACCOUNT" billing projects link "$PROJECT" --billing-account "$BILLING"
fi
g services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com
g artifacts repositories describe naaradh --location "$REGION" >/dev/null 2>&1 ||
  g artifacts repositories create naaradh --location "$REGION" --repository-format docker

IMAGE="$REGION-docker.pkg.dev/$PROJECT/naaradh/web:$(git rev-parse --short HEAD)$(git diff --quiet HEAD || echo -dirty)"
cfg=$(mktemp)
trap 'rm -f "$cfg"' EXIT
cat >"$cfg" <<EOF
steps:
  - name: gcr.io/cloud-builders/docker
    args: [build, -f, web/Dockerfile, -t, '$IMAGE', .]
images: ['$IMAGE']
EOF
# Uploads the repo minus .gitignore'd files (no .gcloudignore), built remotely: nothing local.
g builds submit --config "$cfg" .

g run deploy web --image "$IMAGE" --region "$REGION" --allow-unauthenticated \
  --min-instances 0 --max-instances 2 --cpu 1 --memory 512Mi \
  --set-env-vars NAARADH_SURFACE=marketing,DASHBOARD_URL=https://app.naaradh.com

url=$(g run services describe web --region "$REGION" --format 'value(status.url)')
curl -fsS -o /dev/null "$url/" && echo "live: $url"
