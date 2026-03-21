#!/bin/sh
mkdir -p /data

# Configurable crash-loop parameters (override via environment variables).
API_MAX_FAILURES="${API_MAX_FAILURES:-5}"
API_HEALTHY_SECS="${API_HEALTHY_SECS:-60}"

# Start Node API with exponential backoff on repeated crashes.
# Resets the failure counter after API_HEALTHY_SECS of uptime.
# If the API exceeds the crash threshold, the entire container exits
# so the orchestrator (Docker restart policy / Kubernetes) can handle recovery.
#
# Operational note: monitor for container restarts and the /data/api-crash.log
# file to detect crash-loop situations. The HEALTHCHECK in the Dockerfile will
# also fail once the API is down, providing an additional signal.
(
  failures=0
  while true; do
    start_ts=$(date +%s)
    echo "INFO: Starting Node API (attempt $((failures + 1))/$API_MAX_FAILURES max-failures)..." >&2
    node /app/api/server.js
    exit_code=$?
    elapsed=$(( $(date +%s) - start_ts ))

    # If the process ran long enough, treat it as healthy and reset
    if [ "$elapsed" -ge "$API_HEALTHY_SECS" ]; then
      failures=0
    else
      failures=$((failures + 1))
    fi

    echo "WARN: Node API exited with status $exit_code after ${elapsed}s (failure $failures/$API_MAX_FAILURES)" >&2

    if [ "$failures" -ge "$API_MAX_FAILURES" ]; then
      echo "CRITICAL: Node API crashed $API_MAX_FAILURES times in rapid succession (last exit=$exit_code); terminating container." >&2
      echo "crashed at $(date -Iseconds) after $API_MAX_FAILURES consecutive rapid failures (last exit=$exit_code)" > /data/api-crash.log
      # Kill nginx to stop the container — avoids a degraded state where
      # frontend is up but API is permanently down. The orchestrator
      # (Docker restart policy / Kubernetes) will handle recovery.
      nginx -s quit 2>/dev/null || kill "$(cat /var/run/nginx.pid 2>/dev/null)" 2>/dev/null
      exit 1
    fi

    delay=$(( 2 ** failures ))
    echo "INFO: Restarting API in ${delay}s..." >&2
    sleep "$delay"
  done
) &

# Run nginx in the foreground as PID 1's child.
# If nginx exits (naturally or killed by the API crash handler above),
# the container stops and the orchestrator can restart it.
nginx -g 'daemon off;'
