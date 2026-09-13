# Partial backend configuration: bucket and prefix are supplied at init time so the same root
# module serves every environment and `terraform init -backend=false` works offline (CI).
#
#   terraform -chdir=infra init \
#     -backend-config="bucket=naaradh-tfstate-<env>" \
#     -backend-config="prefix=naaradh/<env>"
#
# The state bucket is created by hand ONCE per environment and is never managed from the state
# it holds (docs/runbooks/deploy.md "Bootstrap"). It is versioned; state contains secrets that
# Terraform reads (e.g. the Redis AUTH string), so access is limited to the deployer/planner
# identities and the humans who apply.
terraform {
  backend "gcs" {}
}
