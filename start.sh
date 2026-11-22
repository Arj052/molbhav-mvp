#!/bin/bash
# Keeps MolBhav running: if the app ever stops, it starts again after 2 seconds.
# Stop it with Ctrl+C (press twice).
cd "$(dirname "$0")"
lsof -ti :3000 | xargs kill 2>/dev/null
while true; do
  node server.js
  echo "[start.sh] App stopped — restarting in 2 seconds (Ctrl+C again to quit)…"
  sleep 2
done
