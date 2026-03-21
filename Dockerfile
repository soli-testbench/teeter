FROM nginx:1.27-alpine3.21
# Pin Node.js LTS 22.x to exact Alpine package version for reproducible builds.
# Update policy: bump the pin when Alpine 3.21 publishes security patches for
# the nodejs package (check: apk update && apk info -v nodejs).
# If the pinned version is unavailable, remove the =version suffix to unblock
# builds, then re-pin once the new version is confirmed.
RUN apk add --no-cache 'nodejs=22.15.1-r0' \
 && node --version | grep -q '^v22\.' \
 || (echo "ERROR: unexpected Node.js major version" && exit 1)
RUN rm -rf /usr/share/nginx/html/*
COPY nginx.conf /etc/nginx/nginx.conf
COPY index.html /usr/share/nginx/html/
COPY js/ /usr/share/nginx/html/js/
COPY api/server.js /app/api/server.js
COPY start.sh /app/start.sh
RUN chmod +x /app/start.sh
RUN nginx -t
VOLUME /data
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8080/api/health || exit 1
CMD ["/app/start.sh"]
