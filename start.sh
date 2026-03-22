#!/bin/sh
mkdir -p /data
chown appuser:appuser /data
chmod 700 /data

# --- Process model: nginx + supervised Node.js API ---
# nginx serves static files and proxies /api/* to the Node.js backend.
# If the API crashes, nginx continues serving the static game (localStorage
# fallback). The crash supervisor restarts the API with bounded retries.
MAX_RETRIES="${API_MAX_RETRIES:-5}"
RETRY_WINDOW="${API_RETRY_WINDOW:-60}"
RECOVERY_PAUSE="${API_RECOVERY_PAUSE:-60}"
CRASH_SENTINEL="/tmp/api_crash_exhausted"

# Remove stale sentinel from previous runs
rm -f "$CRASH_SENTINEL"

# Start Node API in the background with bounded restarts and auto-recovery.
# server.js always starts (no hard-fail). When ALLOW_ANONYMOUS_SCORES=false
# and no SCORE_API_KEY, it runs in read-only mode (GET works, POST returns 403).
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
      failures=0
      window_start=$now
    fi

    failures=$((failures + 1))
    echo "WARN: Node API exited with status $exit_code (failure $failures/$MAX_RETRIES in ${elapsed}s window)." >&2

    if [ "$failures" -ge "$MAX_RETRIES" ]; then
      echo "ERROR: Node API crashed $MAX_RETRIES times within ${RETRY_WINDOW}s." >&2
      echo "INFO: Writing crash sentinel and entering ${RECOVERY_PAUSE}s recovery cooldown..." >&2
      echo "API_CRASHED=$(date -Iseconds) failures=$MAX_RETRIES window=${RETRY_WINDOW}s exit_code=$exit_code" > "$CRASH_SENTINEL"

      sleep "$RECOVERY_PAUSE"
      echo "INFO: Recovery cooldown elapsed. Resetting crash budget and restarting API..." >&2
      rm -f "$CRASH_SENTINEL"
      failures=0
      window_start=$(date +%s)
      continue
    fi

    sleep 2
  done
) &

# Startup smoke test: wait for the API to be ready, then verify /api/scores
# is functional. This catches configuration errors early (e.g. missing deps,
# permission issues on /data) before nginx starts accepting traffic.
SMOKE_RETRIES=10
SMOKE_OK=false
for i in $(seq 1 $SMOKE_RETRIES); do
  if wget -qO- http://127.0.0.1:3001/api/health >/dev/null 2>&1; then
    # Health endpoint is up — now verify scores endpoint returns valid JSON
    if wget -qO- http://127.0.0.1:3001/api/scores 2>/dev/null | head -c 1 | grep -q '\['; then
      echo "INFO: Startup smoke test passed — /api/scores is functional." >&2
      SMOKE_OK=true
      break
    fi
  fi
  sleep 1
done

# STRICT_STARTUP (default: true): when enabled, the container exits with an
# error if the API smoke test fails, ensuring the container never appears
# healthy while /api/scores is non-functional. Set to "false" to allow
# nginx to start even if the API is unhealthy (graceful degradation to
# localStorage-only mode).
STRICT_STARTUP="${STRICT_STARTUP:-true}"

if [ "$SMOKE_OK" = "false" ]; then
  if [ "$STRICT_STARTUP" = "true" ]; then
    echo "ERROR: Startup smoke test failed — /api/scores not healthy after ${SMOKE_RETRIES}s. Exiting (STRICT_STARTUP=true)." >&2
    exit 1
  else
    echo "WARN: Startup smoke test did not pass within ${SMOKE_RETRIES}s. API may still be starting (STRICT_STARTUP=false)." >&2
  fi
fi

# Run nginx in the foreground as PID 1's child.
nginx -g 'daemon off;'
