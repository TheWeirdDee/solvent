# SOLVENT sidecar: epoch closer + Nostr publisher + evidence API
# (src/sidecar/service.ts). Build context: the repository root.
#   docker build -f deploy/sidecar/Dockerfile -t solvent-sidecar .
FROM node:24-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json ./
COPY src/ src/
# Build-time JSON the shared verification modules import (public data only).
COPY evidence/nostr/live-demo.json evidence/nostr/live-demo.json
COPY evidence/reserves/live-attestation.json evidence/reserves/live-attestation.json
ENV NODE_ENV=production
EXPOSE 8086
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.SOLVENT_SIDECAR_PORT || 8086) + '/healthz').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"
CMD ["npx", "tsx", "src/sidecar/service.ts"]
