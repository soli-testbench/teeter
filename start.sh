#!/bin/sh
mkdir -p /data
chown appuser:appuser /data
chmod 700 /data

MAX_RETRIES=5
RETRY_WINDOW=60

# Start Node API in the background with bounded restarts.
# Gives up after MAX_RETRIES failures within RETRY_WINDOW seconds to
# avoid masking persistent crash conditions.  The API is non-critical —
# the frontend continues serving with localStorage fallback.
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
      # Write sentinel so external health checks can detect API crash-loop exhaustion.
      # The Docker HEALTHCHECK already fails because nginx returns 502 for /api/health
      # when the API backend is down, but this file provides an additional signal.
      echo "API_CRASHED=$(date -Iseconds) failures=$MAX_RETRIES window=${RETRY_WINDOW}s" > /tmp/api_crash_exhausted
      break
    fi

    sleep 2
  done
) &

# Run nginx in the foreground as PID 1's child.
nginx -g 'daemon off;'
