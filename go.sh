#!/bin/bash
# One command to run MolBhav and share it:
#   - starts the app (and restarts it automatically if it ever stops)
#   - opens a Cloudflare tunnel and prints your public + admin links
#   - keeps the Mac awake while this window is open
# Keep this ONE Terminal window open. Press Ctrl+C to stop everything.
cd "$(dirname "$0")"
mkdir -p data

# stop anything left over from earlier runs
lsof -ti :3000 | xargs kill 2>/dev/null
pkill -f "cloudflared tunnel --url http://localhost:3000" 2>/dev/null
sleep 1

( while true; do
    node server.js >> data/app.log 2>&1
    echo "[go.sh] app stopped at $(date) — restarting" >> data/app.log
    sleep 2
  done ) &
APP_LOOP=$!

caffeinate -i -w $$ &

cleanup() {
  kill $APP_LOOP 2>/dev/null
  lsof -ti :3000 | xargs kill 2>/dev/null
  pkill -f "cloudflared tunnel --url http://localhost:3000" 2>/dev/null
  rm -f LINK.txt
  echo; echo "MolBhav stopped."
  exit 0
}
trap cleanup INT TERM

sleep 2
if ! lsof -ti :3000 >/dev/null; then
  echo "The app didn't start. Last lines of data/app.log:"; tail -15 data/app.log; cleanup
fi
echo "App running. Opening the tunnel (takes a few seconds)…"

ADMIN_PATH=$(grep '^ADMIN_PATH=' .env | cut -d= -f2)
cloudflared tunnel --url http://localhost:3000 2>&1 | tee -a data/tunnel.log | while IFS= read -r line; do
  if [[ "$line" =~ (https://[a-z0-9-]+\.trycloudflare\.com) ]]; then
    url="${BASH_REMATCH[1]}"
    echo "$url" > LINK.txt
    echo
    echo "=================================================================="
    echo "  PUBLIC LINK (share):  $url"
    echo "  ADMIN LINK (private): $url$ADMIN_PATH/"
    echo "=================================================================="
    echo "  Keep this window open. Ctrl+C stops everything."
    echo
  fi
done
cleanup
