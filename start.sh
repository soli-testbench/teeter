#!/bin/sh
mkdir -p /data
chown appuser:appuser /data
chmod 700 /data

# --- Crash-budget policy (configurable via environment) ---
# The API process is restarted up to MAX_RETRIES times within a sliding
# RETRY_WINDOW (seconds). If the budget is exhausted the API stays down,
# nginx continues serving the static frontend, and the game falls back to
# localStorage for leaderboard data. A sentinel file is written so
# external health-checks / orchestrators can detect the state and
# restart the container if desired.
#
# Override defaults by setting these env vars in your Dockerfile or
# docker-compose.yml:
#   API_MAX_RETRIES  – max crash restarts within the window (default 5)
#   API_RETRY_WINDOW – window length in seconds (default 60)
MAX_RETRIES="${API_MAX_RETRIES:-5}"
RETRY_WINDOW="${API_RETRY_WINDOW:-60}"
CRASH_SENTINEL="/tmp/api_crash_exhausted"

# Remove stale sentinel from previous runs
rm -f "$CRASH_SENTINEL"

# Start Node API in the background with bounded restarts.
(
  failures=0
  window_start=$(date +%s)

  while true; do
    echo "INFO: Starting Node API..." >&2
    su -s /bin/sh appuser -c 'node /app/api/server.js'
    exit_code=$?
    now=$(date +%s)
    elapsed=$((now - window_start))

    if [ "$elapsed" -ge "$RETRY_WINDOW" ]; then
      # Reset failure counter after the window elapses
      failures=0
      window_start=$now
    fi

    failures=$((failures + 1))
    echo "WARN: Node API exited with status $exit_code (failure $failures/$MAX_RETRIES in ${elapsed}s window)." >&2

    if [ "$failures" -ge "$MAX_RETRIES" ]; then
      echo "ERROR: Node API crashed $MAX_RETRIES times within ${RETRY_WINDOW}s — giving up. Leaderboard API is unavailable." >&2
      echo "ERROR: Container HEALTHCHECK will now fail. Orchestrator should restart/alert." >&2
      # Write sentinel so external health checks can detect API crash-loop exhaustion.
      echo "API_CRASHED=$(date -Iseconds) failures=$MAX_RETRIES window=${RETRY_WINDOW}s exit_code=$exit_code" > "$CRASH_SENTINEL"
      break
    fi

    sleep 2
  done
) &

# Run nginx in the foreground as PID 1's child.
nginx -g 'daemon off;'
