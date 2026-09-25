#!/usr/bin/env bash
# Expose the local Next.js API to a physical phone via a Cloudflare quick tunnel.
#
# Quick-tunnel URLs change on every start, so this script also rewrites:
#   .env.local   GOOGLE_REDIRECT_URI  -> <tunnel>/api/auth/google/callback
#   mobile/.env  EXPO_PUBLIC_API_URL  -> <tunnel>
# and prints the redirect URI you must add in Google Cloud Console.
#
# Usage (from repo root, with `npm run dev` already running in another terminal):
#   ./scripts/phone-dev.sh
# Then in a third terminal:  cd mobile && npx expo start --dev-client
# Ctrl-C here stops the tunnel.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LOG="$(mktemp -t aria-cloudflared)"

command -v cloudflared >/dev/null || { echo "cloudflared missing: brew install cloudflared"; exit 1; }
curl -s -o /dev/null localhost:3000 || { echo "Next.js not running on :3000 — start 'npm run dev' first"; exit 1; }

cloudflared tunnel --no-autoupdate --url http://localhost:3000 >"$LOG" 2>&1 &
TUNNEL_PID=$!
trap 'kill $TUNNEL_PID 2>/dev/null; rm -f "$LOG"' EXIT

URL=""
for _ in $(seq 1 30); do
  URL="$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' "$LOG" | head -1 || true)"
  [ -n "$URL" ] && break
  sleep 1
done
[ -n "$URL" ] || { echo "Tunnel failed to start:"; cat "$LOG"; exit 1; }

sed -i '' -E "s#^GOOGLE_REDIRECT_URI=.*#GOOGLE_REDIRECT_URI=$URL/api/auth/google/callback#" "$ROOT/.env.local"
sed -i '' -E "s#^EXPO_PUBLIC_API_URL=.*#EXPO_PUBLIC_API_URL=$URL#" "$ROOT/mobile/.env"

echo ""
echo "Tunnel:      $URL"
echo "Updated:     .env.local GOOGLE_REDIRECT_URI, mobile/.env EXPO_PUBLIC_API_URL"
echo ""
echo "Google Cloud Console -> APIs & Services -> Credentials -> OAuth client -> Authorized redirect URIs, add:"
echo "  $URL/api/auth/google/callback"
echo ""
echo "Restart Metro (npx expo start --dev-client) so the app picks up the new API URL."
echo "Press Ctrl-C to stop the tunnel."
wait $TUNNEL_PID
