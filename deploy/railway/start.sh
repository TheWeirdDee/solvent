#!/bin/bash
# Starts the SOLVENT mint and sidecar in one container (docs/DEPLOY-RAILWAY.md).
#
#   mint     deploy/mint/entrypoint.sh -> cdk-mintd on 0.0.0.0:8085
#   sidecar  src/sidecar/service.ts    -> evidence API on :8086
#
# Each process gets only the secrets it uses: the mint never sees the manifest,
# reserve or Nostr keys, and the sidecar never sees the mint seed. If either
# process exits, the container exits and Railway restarts it.
set -euo pipefail

fail() { echo "solvent-railway: $*" >&2; exit 1; }

DATA=/data
MINT_URL="${SOLVENT_PUBLIC_MINT_URL:-}"

# Where the mint's public URL, and therefore its NUT-06 delegation, lives.
case "$MINT_URL" in
  https://*) ;;
  http://127.0.0.1:*|http://localhost:*) [ "${SOLVENT_ALLOW_LOCAL_MINT_URL:-}" = 1 ] || fail "SOLVENT_PUBLIC_MINT_URL must be https:// (local URLs need SOLVENT_ALLOW_LOCAL_MINT_URL=1)" ;;
  *) fail "SOLVENT_PUBLIC_MINT_URL must be the mint's public https:// URL (the Railway domain targeting port 8085), got '${MINT_URL}'" ;;
esac
MINT_URL="${MINT_URL%/}"

# Railway sets these when running there: the database must be on a volume, and
# the health check (PORT) must reach the mint.
if [ -n "${RAILWAY_PROJECT_ID:-}" ]; then
  [ "${RAILWAY_VOLUME_MOUNT_PATH:-}" = "$DATA" ] || fail "attach a Railway volume mounted at $DATA (found '${RAILWAY_VOLUME_MOUNT_PATH:-none}'): the mint database must persist"
fi
[ -z "${PORT:-}" ] || [ "$PORT" = 8085 ] || fail "set the service variable PORT=8085 (the mint's port, used by the health check), got PORT=$PORT"

# Tolerate one layer of quotes around a pasted value.
unquote() {
  local v="$1" q
  for q in "'" '"'; do
    if [ "${#v}" -ge 2 ] && [ "${v:0:1}" = "$q" ] && [ "${v: -1}" = "$q" ]; then v="${v:1:${#v}-2}"; break; fi
  done
  printf '%s' "$v"
}
CDK_MINTD_MNEMONIC=$(unquote "${CDK_MINTD_MNEMONIC:-}"); export CDK_MINTD_MNEMONIC
SOLVENT_RESERVE_KEY_JSON=$(unquote "${SOLVENT_RESERVE_KEY_JSON:-}"); export SOLVENT_RESERVE_KEY_JSON

: "${CDK_MINTD_MNEMONIC:?CDK_MINTD_MNEMONIC is required}"
: "${SOLVENT_MANIFEST_PRIVKEY:?SOLVENT_MANIFEST_PRIVKEY is required}"
: "${SOLVENT_RESERVE_KEY_JSON:?SOLVENT_RESERVE_KEY_JSON is required (npm run railway:secrets)}"
: "${SOLVENT_RESERVE_OUTPOINT:?SOLVENT_RESERVE_OUTPOINT is required (txid:vout)}"

# The delegation binds the mint URL. Never run a mint whose persisted
# delegation names a different URL than the one wallets are told to use.
if [ -s "$DATA/delegation.json" ]; then
  BOUND=$(node -e "process.stdout.write(JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')).mint_url)" "$DATA/delegation.json")
  [ "$BOUND" = "$MINT_URL" ] || fail "the persisted delegation is bound to $BOUND, not SOLVENT_PUBLIC_MINT_URL=$MINT_URL (docs/DEPLOY-RAILWAY.md: changing the mint URL)"
fi

# Mint config for first boot: the fakewallet demo document with the public URL.
mkdir -p /run/solvent && chmod 700 /run/solvent
sed "s#^url = .*#url = \"$MINT_URL\"#" /opt/solvent/mint.fakewallet.toml > /run/solvent/mint.toml

MANIFEST_PUB=$(cd /app && node -e "const c=require('@cashu/cashu-ts');process.stdout.write(Buffer.from(c.getPubKeyFromPrivKey(Buffer.from(process.env.SOLVENT_MANIFEST_PRIVKEY,'hex'))).toString('hex'))")

(umask 077 && printf '%s' "$SOLVENT_RESERVE_KEY_JSON" > /run/solvent/reserve-key.json)

env -u SOLVENT_MANIFEST_PRIVKEY -u SOLVENT_RESERVE_KEY_JSON -u SOLVENT_NOSTR_SECRET_HEX \
  SOLVENT_MINT_WORKDIR="$DATA" SOLVENT_MINT_CONFIG=/run/solvent/mint.toml SOLVENT_MINT_PORT=8085 \
  SOLVENT_MANIFEST_PUBKEY="$MANIFEST_PUB" \
  solvent-mint-entrypoint &
MINT_PID=$!

(cd /app && exec env -u CDK_MINTD_MNEMONIC -u SOLVENT_RESERVE_KEY_JSON -u PORT \
  SOLVENT_MINT_URL="$MINT_URL" \
  SOLVENT_MINT_DB="$DATA/cdk-mintd.sqlite" \
  SOLVENT_MANIFEST_DELEGATION="$DATA/delegation.json" \
  SOLVENT_PUBLICATION_STORE="$DATA/solvent-publications.json" \
  SOLVENT_RESERVE_KEY_FILE=/run/solvent/reserve-key.json \
  SOLVENT_LIGHTNING_BACKEND=fakewallet \
  SOLVENT_SIDECAR_PORT=8086 \
  npx tsx src/sidecar/service.ts) &
SIDECAR_PID=$!

# Railway stops a deployment with SIGTERM: pass it on so cdk-mintd and the
# sidecar shut down cleanly (bash as PID 1 would otherwise ignore it).
trap 'kill -TERM "$MINT_PID" "$SIDECAR_PID" 2>/dev/null; wait; exit 0' TERM INT

wait -n || true
fail "a process exited; restarting the container"
