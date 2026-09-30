# SOLVENT on Railway: the real mint (deploy/mint) and the SOLVENT sidecar
# (deploy/sidecar) in ONE service, because they share one SQLite file —
# SOLVENT's triggers run inside CDK's own transactions, and the sidecar's
# epoch closer writes the same database — and a Railway volume attaches to a
# single service. See docs/DEPLOY-RAILWAY.md. Build context: the repository root.
#   docker build -f deploy/railway/Dockerfile -t solvent-railway .
#
# The build stage is byte-for-byte the one in deploy/mint/Dockerfile (the
# Deploy Stack Check builds both, so a drift shows up there and the layers
# are shared).

FROM rust:1-bookworm AS build
RUN apt-get update \
 && apt-get install -y --no-install-recommends protobuf-compiler git \
 && rm -rf /var/lib/apt/lists/*
ARG CDK_COMMIT=a056e0f0f69e94f431b1aeb90d883f18c61ea4c6
WORKDIR /src
RUN git clone https://github.com/cashubtc/cdk.git cdk \
 && cd cdk && git -c advice.detachedHead=false checkout "$CDK_COMMIT"
COPY patches/cdk/ /patches/
RUN cd cdk && for p in /patches/*.patch; do echo "applying $p"; git apply "$p"; done
# lnd for real Lightning, fakewallet for a clearly-labelled demo deployment.
RUN cd cdk && cargo build --release -p cdk-mintd --no-default-features --features sqlite,lnd,fakewallet

FROM node:24-bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates sqlite3 curl \
 && rm -rf /var/lib/apt/lists/*
# Mint (as deploy/mint/Dockerfile).
COPY --from=build /src/cdk/target/release/cdk-mintd /usr/local/bin/cdk-mintd
COPY migrations/solvent-accounting/ /opt/solvent/migrations/
COPY deploy/mint/entrypoint.sh /usr/local/bin/solvent-mint-entrypoint
COPY deploy/mint.fakewallet.toml /opt/solvent/mint.fakewallet.toml
# Sidecar (as deploy/sidecar/Dockerfile).
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json ./
COPY src/ src/
COPY evidence/nostr/live-demo.json evidence/nostr/live-demo.json
COPY evidence/reserves/live-attestation.json evidence/reserves/live-attestation.json
COPY deploy/railway/start.sh /usr/local/bin/solvent-railway-start
RUN chmod +x /usr/local/bin/solvent-mint-entrypoint /usr/local/bin/solvent-railway-start
ENV NODE_ENV=production
# No VOLUME instruction: Railway rejects it. Attach a Railway volume at /data.
EXPOSE 8085 8086
CMD ["solvent-railway-start"]
