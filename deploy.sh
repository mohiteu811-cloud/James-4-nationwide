#!/usr/bin/env bash
#
# One-command deploy for the James4Nationwide referral worker (+ optional
# staffer console to Cloudflare Pages). Safe to re-run.
#
#   ./deploy.sh            # deploy worker, prompt for any missing secrets
#   ./deploy.sh --console  # also deploy the staffer console to Cloudflare Pages
#   ./deploy.sh --no-test  # skip the test run before deploying
#
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
WORKER_DIR="$ROOT/referral-worker"
CONSOLE_DIR="$ROOT/staffer-console"
CONSOLE_PROJECT="james4nationwide-console"

DO_CONSOLE=false
RUN_TESTS=true
for arg in "$@"; do
  case "$arg" in
    --console) DO_CONSOLE=true ;;
    --no-test) RUN_TESTS=false ;;
    *) echo "Unknown option: $arg" >&2; exit 1 ;;
  esac
done

say() { printf "\n\033[1;36m==> %s\033[0m\n" "$1"; }
warn() { printf "\033[1;33m%s\033[0m\n" "$1"; }

command -v node >/dev/null || { echo "Node.js is required (v18+)."; exit 1; }

cd "$WORKER_DIR"

say "Installing dependencies"
npm install --no-audit --no-fund

say "Checking Cloudflare login"
if ! npx --yes wrangler whoami >/dev/null 2>&1; then
  warn "Not logged in — opening browser to authorise Cloudflare…"
  npx wrangler login
fi
npx wrangler whoami | sed -n '1,3p' || true

# Ensure each required secret exists; prompt to set any that are missing.
say "Checking secrets"
EXISTING="$(npx wrangler secret list 2>/dev/null || echo '[]')"
for name in MAILERLITE_API_TOKEN WEBHOOK_SECRET STAFF_TOKEN; do
  if echo "$EXISTING" | grep -q "\"$name\""; then
    echo "  ✓ $name already set"
  else
    warn "  • $name is not set."
    if [ "$name" != "MAILERLITE_API_TOKEN" ]; then
      echo "    Tip: generate one with  openssl rand -hex 24"
    fi
    npx wrangler secret put "$name"
  fi
done

if [ "$RUN_TESTS" = true ]; then
  say "Running tests"
  npm test
fi

say "Deploying the worker"
npx wrangler deploy

WORKER_URL="$(npx wrangler deployments list 2>/dev/null | grep -oE 'https://[a-zA-Z0-9.-]+workers\.dev' | head -1 || true)"
if [ -n "$WORKER_URL" ]; then
  say "Worker is live at: $WORKER_URL"
  echo "  Use this as WORKER_BASE in the WordPress pages and the staffer console."
  echo "  Webhook URL: $WORKER_URL/webhook?token=<your WEBHOOK_SECRET>"
fi

if [ "$DO_CONSOLE" = true ]; then
  say "Deploying the staffer console to Cloudflare Pages"
  npx wrangler pages deploy "$CONSOLE_DIR" --project-name "$CONSOLE_PROJECT" --commit-dirty=true
fi

say "Done."
echo "Next: set the MailerLite webhook, paste WORKER_BASE into the WordPress pages,"
echo "and (if you didn't pass --console) deploy the console with: ./deploy.sh --console"
