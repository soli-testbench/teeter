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
# SCORE_API_KEY: Optional. When set, POST /api/scores requires a matching
# X-API-Key header. Not required for the default browser-based deployment
# (the game client submits scores anonymously, protected by rate limiting,
# input validation, and CSP/CORS restrictions).
EXPOSE 8080
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
