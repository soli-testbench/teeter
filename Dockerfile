FROM nginx:1.27-alpine3.21
# Install Node.js LTS from Alpine 3.21 official packages.
# Pinned to 22.x minor series via apk constraint. Alpine apk packages are
# signed by the distro maintainers; provenance is verified by apk's built-in
# signature checking against /etc/apk/keys. No npm/npx or third-party
# package managers are used — only Node.js stdlib modules.
RUN apk add --no-cache 'nodejs~=22' \
 && node --version \
 && echo "Node.js $(node -e "process.stdout.write(process.version)") installed from Alpine repos"
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
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8080/api/health || exit 1
CMD ["/app/start.sh"]
