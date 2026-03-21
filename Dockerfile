FROM nginx:1.27-alpine3.21
# Install Node.js LTS from Alpine 3.21 packages.
# Pinned to 22.x minor version for reproducible builds.
RUN apk add --no-cache 'nodejs~=22' \
 && node --version
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
