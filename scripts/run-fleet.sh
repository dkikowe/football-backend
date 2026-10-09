#!/usr/bin/env bash
# One dedicated Unity process per match. A completed process exits; restart returns to IDLE.
set -euo pipefail
cd "$(dirname "$0")/.."
if [[ -f .env.local ]]; then set -a; source .env.local; set +a; fi
: "${GAME_SERVER_SECRET:?Run npm run local:init or configure GAME_SERVER_SECRET}"
: "${UNITY_SERVER_BINARY:?Set UNITY_SERVER_BINARY to Linux executable or Mac .app/Contents/MacOS/Football}"
[[ -x "$UNITY_SERVER_BINARY" ]] || { echo 'UNITY_SERVER_BINARY is not executable.' >&2; exit 1; }
FLEET_SIZE="${FLEET_SIZE:-1}"
BASE_GAME_PORT="${GAME_PORT:-7777}"
[[ "$FLEET_SIZE" =~ ^[1-9][0-9]?$ ]] || { echo 'FLEET_SIZE must be 1..99.' >&2; exit 1; }
mkdir -p .local/fleet
children=()
cleanup(){ for child in "${children[@]}"; do kill -TERM "$child" 2>/dev/null || true; done; }
trap cleanup EXIT INT TERM
for ((instance=0;instance<FLEET_SIZE;instance++)); do
  (
    current_pid=''
    trap '[[ -z "$current_pid" ]] || kill -TERM "$current_pid" 2>/dev/null || true; exit 0' INT TERM
    export BACKEND_URL="${BACKEND_URL:-http://127.0.0.1:3000}"
    export GAME_SERVER_ID="${GAME_SERVER_ID_PREFIX:-local}-$(hostname -s)-$instance"
    export GAME_PORT="$((BASE_GAME_PORT+instance))"
    export GAME_REGION="${GAME_REGION:-local}"
    export GAME_PUBLIC_ADDRESS="${GAME_PUBLIC_ADDRESS:-127.0.0.1}"
    export GAME_LISTEN_ADDRESS="${GAME_LISTEN_ADDRESS:-127.0.0.1}"
    while true; do
      # Registration has its own retry in Unity; health gate avoids noisy restart loops.
      until curl --fail --silent --max-time 3 "$BACKEND_URL/health" >/dev/null; do sleep 2; done
      logfile=".local/fleet/server-${instance}-$(date -u +%Y%m%dT%H%M%SZ).log"
      "$UNITY_SERVER_BINARY" -batchmode -nographics -football-server -game-port "$GAME_PORT" -logFile "$logfile" &
      current_pid=$!
      wait "$current_pid" || true
      current_pid=''
      sleep 2
    done
  ) &
  children+=("$!")
done
wait
