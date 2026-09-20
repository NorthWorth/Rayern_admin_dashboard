#!/bin/sh
# Runs the dashboard API and the Vite frontend together for the Freebuff preview.
# API binds to $API_PORT (default 4000); Vite binds to the injected PORT (5173).
cd "$(dirname "$0")/.."
bun server/node_modules/.bin/tsx server/src/index.ts &
API_PID=$!
trap 'kill $API_PID 2>/dev/null' EXIT INT TERM
exec bun x vite
