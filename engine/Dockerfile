FROM node:22-slim

ENV NODE_ENV=production \
    STATE_DIR=/state \
    PUBLISH_DIR=/data

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY tsconfig.json ./
COPY src ./src

# Named volumes inherit this ownership on first mount, so the engine can write as a non-root user.
RUN mkdir -p /state /data && chown node:node /state /data
USER node

# Healthy while the run loop keeps beating (an epoch can take several minutes).
HEALTHCHECK --interval=2m --timeout=10s --start-period=3m \
  CMD node -e "const t=+require('fs').readFileSync(process.env.STATE_DIR+'/heartbeat','utf8');process.exit(Date.now()-t<30*60e3?0:1)"

CMD ["node", "--import", "tsx", "src/main.ts", "run"]
