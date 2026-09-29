# SOLVENT real mint: cdk-mintd built from the pinned CDK source with
# SOLVENT's patch series (patches/cdk/0001-0009) applied — the same source
# and patches the real-LND CI builds. Build context: the repository root.
#   docker build -f deploy/mint/Dockerfile -t solvent-mint .

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

FROM debian:bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates sqlite3 curl \
 && rm -rf /var/lib/apt/lists/*
COPY --from=build /src/cdk/target/release/cdk-mintd /usr/local/bin/cdk-mintd
COPY migrations/solvent-accounting/ /opt/solvent/migrations/
COPY deploy/mint/entrypoint.sh /usr/local/bin/solvent-mint-entrypoint
RUN chmod +x /usr/local/bin/solvent-mint-entrypoint
VOLUME /data
EXPOSE 8085
HEALTHCHECK --interval=15s --timeout=5s --start-period=60s CMD curl -sf http://127.0.0.1:${SOLVENT_MINT_PORT:-8085}/v1/info || exit 1
ENTRYPOINT ["solvent-mint-entrypoint"]
