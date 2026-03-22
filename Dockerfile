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
# IMPORTANT: Single-instance only. The JSON file store is not safe for
# multi-replica deployments. Use a shared external datastore (e.g. Redis
# or a database) if horizontal scaling is needed.
VOLUME /data
# --- Deployment security policy ---
#
# HTTPS REQUIREMENT: This container serves plain HTTP on port 8080. You MUST
# place an HTTPS-terminating reverse proxy (e.g. Cloudflare, AWS ALB, Caddy)
# in front of this port for any non-localhost deployment. Failing to do so
# exposes score submissions and challenge tokens to network interception.
# The nginx config inside this image does NOT terminate TLS.
#
# --- Default: anonymous writes DISABLED (secure-by-default) ---
# ALLOW_ANONYMOUS_SCORES defaults to false. Operators must explicitly opt in
# to anonymous submissions at deploy time.
#
# For the shared leaderboard (casual browser game, no user accounts):
#   docker run -e ALLOW_ANONYMOUS_SCORES=true -p 8080:8080 <image>
#
# For authenticated submissions (server-to-server):
#   docker run -e SCORE_API_KEY=<secret> -p 8080:8080 <image>
#
# When ALLOW_ANONYMOUS_SCORES=true, abuse resistance (defense-in-depth):
#   - Challenge tokens (one-time, IP-bound, 5-min TTL, max 5 pending/IP)
#   - Rate limiting (3 POST/min/IP)
#   - Per-IP cooldown (10s between submissions)
#   - Duplicate detection, input validation, body size cap
#   - CORS denial (no Access-Control-Allow-Origin header)
#   - CSP connect-src 'self' (blocks cross-origin script access)
#   - Server binds 127.0.0.1 only (nginx proxy required)
#
# Accepted risk (when anonymous mode enabled): a determined attacker with
# multiple IPs could insert fake scores. This is appropriate for non-critical
# game score data.
ENV NODE_ENV=production
ENV ALLOW_ANONYMOUS_SCORES=false
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD test ! -f /tmp/api_crash_exhausted && wget -qO- http://127.0.0.1:8080/api/health || exit 1
CMD ["/app/start.sh"]
