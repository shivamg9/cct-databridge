# CCT DataBridge frontend: the static operator console, served by Nginx, with /api/ proxied to the backend.
FROM nginx:alpine

COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY prototype/index.html prototype/app.js prototype/ui-terms.js prototype/engine.js prototype/schema.js /usr/share/nginx/html/

EXPOSE 8080

HEALTHCHECK --interval=15s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO /dev/null http://127.0.0.1:8080/ || exit 1
