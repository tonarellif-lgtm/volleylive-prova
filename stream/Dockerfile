FROM node:22-bookworm-slim

# ffmpeg serve per convertire il video in RTMP; ca-certificates per RTMPS (YouTube/Facebook)
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

COPY lib.js server.mjs healthcheck.mjs ./

ENV NODE_ENV=production PORT=8080
USER node
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD ["node", "healthcheck.mjs"]

CMD ["node", "server.mjs"]
