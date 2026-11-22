#!/bin/bash
# Copies the app's settings from .env into the linked Vercel project (Production).
# Values are read exactly as the app reads them (dotenv, so quotes are handled) and piped
# straight to Vercel, never printed.
set -e
cd "$(dirname "$0")/.."
val() { node -e "require('dotenv').config(); process.stdout.write(process.env['$1'] || '')"; }
for key in ADMIN_EMAIL ADMIN_PASSWORD_HASH ADMIN_PATH ADMIN_TOTP_SECRET GOOGLE_CLIENT_ID; do
  v=$(val "$key")
  [ -z "$v" ] && { echo "skip $key (empty)"; continue; }
  printf '%s' "$v" | npx --yes vercel@latest env add "$key" production --force >/dev/null 2>&1 && echo "set $key" || echo "FAILED $key"
done
printf 'production' | npx --yes vercel@latest env add NODE_ENV production --force >/dev/null 2>&1 && echo "set NODE_ENV" || echo "FAILED NODE_ENV"
echo "Done. Settings are in Vercel (Project → Settings → Environment Variables)."
