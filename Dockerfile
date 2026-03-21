# Pinned to specific patch version for reproducible builds. Review and bump
# when security patches are released for nginx 1.27.x or Alpine 3.21.
FROM nginx:1.27.5-alpine3.21
# Install Node.js LTS from Alpine 3.21 official packages.
# Pinned to exact patch version for reproducible, hermetic builds.
# Node.js 22 is the current LTS release (codename "Jod", active LTS until
# Oct 2025, maintenance until Apr 2027).
# Alpine apk packages are signed by the distro maintainers; provenance is
# verified by apk's built-in signature checking against /etc/apk/keys.
# No npm/npx or third-party package managers are used — only Node.js stdlib modules.
#
# Update cadence: bump the pinned version when:
#   - A new Node.js 22.x patch is released with security fixes, OR
#   - The base nginx:1.27.5-alpine3.21 image is updated.
# Last CVE review: 2026-03-21 — nodejs=22.15.1-r0 has no known unpatched CVEs
# in Alpine's security tracker at time of pinning.
RUN apk add --no-cache 'nodejs=22.15.1-r0' \
 && NODE_VER="$(node -e "process.stdout.write(process.version)")" \
 && echo "Node.js ${NODE_VER} installed from Alpine repos" \
 && echo "${NODE_VER}" | grep -qE '^v22\.' || { echo "ERROR: expected Node.js v22.x, got ${NODE_VER}"; exit 1; }
RUN rm -rf /usr/share/nginx/html/*
COPY nginx.conf /etc/nginx/nginx.conf
COPY index.html /usr/share/nginx/html/
COPY js/ /usr/share/nginx/html/js/
COPY api/server.js /app/api/server.js
COPY start.sh /app/start.sh
RUN chmod +x /app/start.sh
# Create a non-root user for the Node.js API process (defense-in-depth).
# nginx master still runs as root to manage workers, but the API server
# drops to this unprivileged user via su in start.sh.
RUN adduser -D -H -s /sbin/nologin appuser
RUN nginx -t
# Persistent storage for scores.json. Operators should back up this volume
# according to their retention policy; data is non-critical (game scores).
VOLUME /data
# SCORE_API_KEY: Optional. When set, POST /api/scores additionally requires
# a matching X-API-Key header. Route browser submissions through a backend
# proxy that injects the key after authenticating users.
#
# Default: production mode with anonymous scores DISABLED (secure-by-default).
# To enable browser-based anonymous score submissions (with challenge tokens,
# rate limiting, and cooldown for abuse resistance):
#   docker run -e ALLOW_ANONYMOUS_SCORES=true ...
#
# To require API-key authentication (server-to-server only):
#   docker run -e SCORE_API_KEY=mysecret ...
ENV NODE_ENV=production
ENV ALLOW_ANONYMOUS_SCORES=false
EXPOSE 8080
# --- Deployment auth paths ---
#
# Default (no env overrides): the leaderboard API is DISABLED.
#   start.sh detects the missing auth config and skips API startup entirely
#   (no crash-loop). nginx serves the static game with localStorage-only
#   leaderboard. The health check reports unhealthy (crash sentinel present)
#   so orchestrators can detect the degraded state. To enable the shared
#   leaderboard, set SCORE_API_KEY or ALLOW_ANONYMOUS_SCORES=true.
#
# Anonymous browser mode (casual game deployment):
#   docker run -e ALLOW_ANONYMOUS_SCORES=true -v scores:/data -p 8080:8080 ball-game
#   - Browser clients submit scores directly (no API key needed).
#   - Challenge tokens, rate limiting, and per-IP cooldown prevent casual abuse.
#   - This is the intended mode for a browser-based game where the client
#     cannot securely hold an API key. See threat model in api/server.js.
#
# API-key mode (server-to-server integration):
#   docker run -e SCORE_API_KEY=mysecret -e ALLOW_ANONYMOUS_SCORES=false \
#              -v scores:/data -p 8080:8080 ball-game
#   - POST /api/scores requires X-API-Key header matching SCORE_API_KEY.
#   - Browser clients do NOT hold the key. Route browser submissions through a
#     backend reverse proxy that authenticates users and injects the X-API-Key
#     header into forwarded requests to /api/scores.
#   - Without a proxy, browser score submissions will receive 401 — the static
#     game still works but scores fall back to localStorage only.
#
# Development mode:
#   docker run -e NODE_ENV=development -v scores:/data -p 8080:8080 ball-game
#   - Same as default anonymous mode but with development logging.
#
# Optional tuning (with defaults):
#   API_MAX_RETRIES=5        — max API crash restarts within the retry window
#   API_RETRY_WINDOW=60      — retry window length in seconds
#   API_RECOVERY_PAUSE=60    — seconds to wait before resetting crash budget
#
# Health check verifies both nginx and API backend are up.
# If the crash sentinel (/tmp/api_crash_exhausted) exists, the API has
# exhausted its restart budget and is in recovery cooldown. The supervisor
# automatically resets the budget after API_RECOVERY_PAUSE (default 60s)
# and retries — no container restart required. The sentinel is temporary
# and is removed when the API restarts after cooldown.
# Configurable via: API_MAX_RETRIES (default 5), API_RETRY_WINDOW (default 60s),
# API_RECOVERY_PAUSE (default 60s).
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD test ! -f /tmp/api_crash_exhausted && wget -qO- http://127.0.0.1:8080/api/health || exit 1
CMD ["/app/start.sh"]
