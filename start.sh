#!/bin/sh
mkdir -p /data

# Start Node API with exponential backoff on repeated crashes.
# Resets the failure counter after 60 s of healthy uptime.
# If the API exceeds the crash threshold, the entire container exits
# so the orchestrator (Docker restart policy / Kubernetes) can handle recovery.
(
  MAX_FAILURES=5
  failures=0
  while true; do
    start_ts=$(date +%s)
    node /app/api/server.js
    exit_code=$?
    elapsed=$(( $(date +%s) - start_ts ))

    # If the process ran for >60 s, treat it as a healthy run and reset
    if [ "$elapsed" -ge 60 ]; then
      failures=0
    else
      failures=$((failures + 1))
    fi

    if [ "$failures" -ge "$MAX_FAILURES" ]; then
      echo "CRITICAL: Node API crashed $MAX_FAILURES times in rapid succession (last exit=$exit_code); terminating container." >&2
      echo "crashed at $(date -Iseconds) after $MAX_FAILURES consecutive rapid failures (last exit=$exit_code)" > /data/api-crash.log
      # Kill nginx to stop the container — avoids a degraded state where
      # frontend is up but API is permanently down. The orchestrator
      # (Docker restart policy / Kubernetes) will handle recovery.
      nginx -s quit 2>/dev/null || kill "$(cat /var/run/nginx.pid 2>/dev/null)" 2>/dev/null
      exit 1
    fi

    delay=$(( 2 ** failures ))
    echo "Node API exited with status $exit_code (failure $failures/$MAX_FAILURES), restarting in ${delay}s..." >&2
    sleep "$delay"
  done
) &

# Run nginx in the foreground as PID 1's child.
# If nginx exits (naturally or killed by the API crash handler above),
# the container stops and the orchestrator can restart it.
nginx -g 'daemon off;'
