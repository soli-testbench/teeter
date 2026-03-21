#!/bin/sh
mkdir -p /data
chown appuser:appuser /data
chmod 700 /data

# --- Deployment validation ---
# Warn if SCORE_API_KEY is missing in production. The Node.js server enforces
# its own startup check (process.exit(1)), so we only warn here to allow nginx
# to still serve the static game even if the API cannot start. The API supervisor
# loop below will log the server's FATAL error and retry per the crash-budget policy.
SKIP_API=false
if [ "$NODE_ENV" = "production" ] && [ -z "$SCORE_API_KEY" ] && [ "$ALLOW_ANONYMOUS_SCORES" != "true" ]; then
  echo "======================================================================" >&2
  echo "NOTICE: Global leaderboard API is DISABLED (secure-by-default)." >&2
  echo "" >&2
  echo "NODE_ENV=production requires one of:" >&2
  echo "  1. SCORE_API_KEY=<secret>               (server-to-server auth)" >&2
  echo "  2. ALLOW_ANONYMOUS_SCORES=true           (browser-based game)" >&2
  echo "" >&2
  echo "The static game will be served by nginx with localStorage-only scores." >&2
  echo "To enable the shared leaderboard, restart with one of the above options." >&2
  echo "======================================================================" >&2
  SKIP_API=true
fi

if [ "$NODE_ENV" = "production" ] && [ -z "$SCORE_API_KEY" ] && [ "$ALLOW_ANONYMOUS_SCORES" = "true" ]; then
  echo "WARNING: NODE_ENV=production with ALLOW_ANONYMOUS_SCORES=true (explicit opt-in)." >&2
  echo "Score submissions will be accepted without API-key authentication." >&2
fi

# --- Process model: nginx + supervised Node.js API ---
# This container runs two processes:
#   1. nginx (PID 1's child) — serves static files and proxies /api/* to the
#      Node.js backend on 127.0.0.1:3001.
#   2. Node.js API (background) — handles /api/scores and /api/challenge.
#
# Operational impact compared to nginx-only:
#   - If the API process crashes, nginx continues serving the static game.
#     The frontend detects API unavailability and falls back to localStorage
#     for leaderboard data. The degraded window lasts until the supervisor
#     restarts the API (typically ~2 seconds, or up to RECOVERY_PAUSE seconds
#     if the crash budget is exhausted).
#   - If nginx exits, the container stops (nginx is the foreground process).
#   - The HEALTHCHECK verifies both nginx and the API are healthy. During an
#     API crash-recovery window, the health check fails, signaling orchestrators
#     (Docker Swarm, Kubernetes, etc.) to take appropriate action.
#   - The crash sentinel file (/tmp/api_crash_exhausted) is set during the
#     recovery cooldown so external monitoring can detect the degraded state.
#
# --- Crash-budget policy with supervised recovery ---
# The API process is restarted up to MAX_RETRIES times within a sliding
# RETRY_WINDOW (seconds). If the budget is exhausted, the supervisor
# enters a cooldown period (API_RECOVERY_PAUSE, default 60s) then
# automatically resets the crash budget and retries. This prevents
# prolonged degraded mode — the API self-heals without requiring a
# full container restart.
#
# A sentinel file is written during cooldown so external health-checks
# can detect the degraded state. The sentinel is removed when the API
# is restarted after cooldown.
#
# Override defaults by setting these env vars in your Dockerfile or
# docker-compose.yml:
#   API_MAX_RETRIES    – max crash restarts within the window (default 5)
#   API_RETRY_WINDOW   – window length in seconds (default 60)
#   API_RECOVERY_PAUSE – seconds to wait before resetting budget (default 60)
MAX_RETRIES="${API_MAX_RETRIES:-5}"
RETRY_WINDOW="${API_RETRY_WINDOW:-60}"
RECOVERY_PAUSE="${API_RECOVERY_PAUSE:-60}"
CRASH_SENTINEL="/tmp/api_crash_exhausted"

# Remove stale sentinel from previous runs
rm -f "$CRASH_SENTINEL"

# Start Node API in the background with bounded restarts and auto-recovery.
# When SKIP_API=true (production with no auth configured), skip the API entirely
# to avoid a pointless crash-loop. The health check will reflect API-down state.
if [ "$SKIP_API" = "true" ]; then
  echo "INFO: Skipping API startup (no auth configured). Writing crash sentinel." >&2
  echo "API_DISABLED=true reason=no_auth_configured" > "$CRASH_SENTINEL"
else
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
        echo "ERROR: Node API crashed $MAX_RETRIES times within ${RETRY_WINDOW}s." >&2
        echo "INFO: Writing crash sentinel and entering ${RECOVERY_PAUSE}s recovery cooldown..." >&2
        echo "API_CRASHED=$(date -Iseconds) failures=$MAX_RETRIES window=${RETRY_WINDOW}s exit_code=$exit_code" > "$CRASH_SENTINEL"

        # Supervised recovery: wait, then reset budget and retry
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
fi

# Run nginx in the foreground as PID 1's child.
nginx -g 'daemon off;'
