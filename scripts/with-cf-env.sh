#!/usr/bin/env bash
# Runs a command with the git-ignored cloudflare.env loaded, so credentials never
# appear on a command line. Usage: scripts/with-cf-env.sh npx wrangler d1 list
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [[ -f "$root/cloudflare.env" ]]; then
  # shellcheck disable=SC1091
  source "$root/cloudflare.env"
fi
exec "$@"
