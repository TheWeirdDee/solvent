#!/bin/sh
# SOLVENT mint entrypoint (docs/DEPLOY-REAL-MINT.md).
#
# First boot only:
#   1. import the mint configuration (config init --new-mint)
#   2. start cdk-mintd once so CDK creates its schema, then stop it
#   3. apply SOLVENT migrations 0001-0003 (the epoch lifecycle starts at epoch 1)
# Every boot, if missing:
#   4. have the mint identity (NUT-06 key) delegate the SOLVENT manifest key,
#      valid from epoch 1 — written to /data/delegation.json (public)
# Then run cdk-mintd in the foreground.
#
# Secrets this container holds: CDK_MINTD_MNEMONIC only. The manifest key
# arrives as its PUBLIC key; its private key lives only in the sidecar.
set -eu

WORK="${SOLVENT_MINT_WORKDIR:-/data}"
CONFIG="${SOLVENT_MINT_CONFIG:-/config/mint.toml}"
PORT="${SOLVENT_MINT_PORT:-8085}"
: "${CDK_MINTD_MNEMONIC:?CDK_MINTD_MNEMONIC is required}"
: "${SOLVENT_MANIFEST_PUBKEY:?SOLVENT_MANIFEST_PUBKEY (33-byte compressed hex) is required}"
export CDK_MINTD_MNEMONIC

if [ ! -f "$WORK/.solvent-initialized" ]; then
  echo "solvent-mint: first boot — initializing $WORK"
  cdk-mintd --work-dir "$WORK" config init --new-mint --file "$CONFIG"
  cdk-mintd --work-dir "$WORK" &
  PID=$!
  i=0
  until curl -sf "http://127.0.0.1:$PORT/v1/info" >/dev/null 2>&1; do
    i=$((i + 1))
    if [ "$i" -gt 120 ]; then echo "solvent-mint: cdk-mintd did not come up" >&2; kill "$PID" || true; exit 1; fi
    sleep 1
  done
  kill "$PID"
  wait "$PID" || true
  for m in /opt/solvent/migrations/0001_*.sql /opt/solvent/migrations/0002_*.sql /opt/solvent/migrations/0003_*.sql; do
    echo "solvent-mint: applying $(basename "$m")"
    sqlite3 -bail "$WORK/cdk-mintd.sqlite" < "$m"
  done
  touch "$WORK/.solvent-initialized"
fi

# A deliberate configuration change on an existing volume (switching the
# Lightning backend, or rolling it back): stage the given document, and the
# cdk-mintd started below applies it. Off unless explicitly requested.
if [ -f "$WORK/.solvent-initialized" ] && [ "${SOLVENT_APPLY_MINT_CONFIG:-}" = 1 ]; then
  echo "solvent-mint: SOLVENT_APPLY_MINT_CONFIG=1 — staging $CONFIG"
  cdk-mintd --work-dir "$WORK" config apply --file "$CONFIG"
fi

if [ ! -s "$WORK/delegation.json" ]; then
  echo "solvent-mint: delegating manifest key $SOLVENT_MANIFEST_PUBKEY from epoch 1"
  cdk-mintd --work-dir "$WORK" solvent delegate-manifest-key \
    --manifest-pubkey "$SOLVENT_MANIFEST_PUBKEY" --valid-from-epoch 1 > "$WORK/delegation.json.tmp"
  mv "$WORK/delegation.json.tmp" "$WORK/delegation.json"
fi

exec cdk-mintd --work-dir "$WORK"
