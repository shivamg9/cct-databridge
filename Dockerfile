# CCT DataBridge backend: OpenG2P push/pull REST API (Node built-ins only, no npm install).
FROM node:22-alpine

WORKDIR /app

# Only what the API loads at runtime: the server, plus the engine and generated schema it validates with.
COPY package.json ./
COPY server/api.js server/records.js ./server/
COPY server/integrations ./server/integrations/
COPY prototype/engine.js prototype/schema.js ./prototype/

# Records live on a volume, owned by the unprivileged "node" user that ships with the image.
RUN mkdir -p /data && chown node:node /data
VOLUME ["/data"]
USER node

# Demo mode by default. Integration mode is never enabled by this image or the compose file.
# Pull is masked unless the deployment sets DATABRIDGE_UNMASKED_PULL=true (demo mode only).
# The NSR webhook is off unless the deployment turns it on and supplies its secrets.
ENV NODE_ENV=production \
    DATABRIDGE_MODE=demo \
    HOST=0.0.0.0 \
    PORT=8080 \
    DATABRIDGE_DATA_FILE=/data/demo-records.json \
    DATABRIDGE_UNMASKED_PULL=false \
    NSR_WEBHOOK_ENABLED=false \
    NSR_WEBHOOK_ALLOW_SYNTHETIC=false

EXPOSE 8080

HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8080/api/v1/health || exit 1

# --seed-demo adds 30 synthetic records once; later starts find them and add nothing.
CMD ["node", "server/api.js", "--seed-demo"]
