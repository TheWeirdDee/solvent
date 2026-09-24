# Reproducing the real Cashu stack yourself

Two ways to get the exact same result `.github/workflows/real-cashu-integration.yml` gets in CI: (A) let GitHub Actions run it, or (B) run the identical sequence yourself on Linux or inside WSL2. Both use the exact pinned versions in `docs/dependencies.md` — nothing here installs "latest."

## A. Run it via GitHub Actions (no local setup at all)

```bash
gh workflow run real-cashu-integration.yml
gh run watch
```

(Or trigger it from the GitHub UI: Actions → "Real Cashu Integration (Phase 1)" → Run workflow.) The full evidence package is attached to the run as the `real-cashu-evidence` artifact regardless of whether it passed or failed.

## B. Run it yourself, step by step (Linux or WSL2 — not native Windows; see `docs/dependencies.md` for why)

```bash
git clone https://github.com/TheWeirdDee/solvent.git
cd solvent
npm ci
```

### 1. Bitcoin Core regtest

```bash
curl -sSL -o bitcoin.tar.gz https://bitcoincore.org/bin/bitcoin-core-29.4/bitcoin-29.4-x86_64-linux-gnu.tar.gz
curl -sSL -o SHA256SUMS https://bitcoincore.org/bin/bitcoin-core-29.4/SHA256SUMS
grep bitcoin-29.4-x86_64-linux-gnu.tar.gz SHA256SUMS | sha256sum -c -
tar xzf bitcoin.tar.gz && export PATH="$PWD/bitcoin-29.4/bin:$PATH"

mkdir -p ~/.solvent-regtest/bitcoin
cat > ~/.solvent-regtest/bitcoin/bitcoin.conf <<'EOF'
regtest=1
server=1
txindex=1
fallbackfee=0.0001
rpcuser=solvent
rpcpassword=solvent-regtest-only
[regtest]
rpcport=18443
zmqpubrawblock=tcp://127.0.0.1:28332
zmqpubrawtx=tcp://127.0.0.1:28333
EOF
bitcoind -datadir=~/.solvent-regtest/bitcoin -daemon
bitcoin-cli -datadir=~/.solvent-regtest/bitcoin -regtest createwallet miner
MINE_ADDR=$(bitcoin-cli -datadir=~/.solvent-regtest/bitcoin -regtest getnewaddress)
bitcoin-cli -datadir=~/.solvent-regtest/bitcoin -regtest generatetoaddress 110 "$MINE_ADDR"
```

### 2. Two real LND nodes

```bash
curl -sSL -o lnd.tar.gz https://github.com/lightningnetwork/lnd/releases/download/v0.21.3-beta/lnd-linux-amd64-v0.21.3-beta.tar.gz
curl -sSL -o manifest.txt https://github.com/lightningnetwork/lnd/releases/download/v0.21.3-beta/manifest-v0.21.3-beta.txt
grep lnd-linux-amd64-v0.21.3-beta.tar.gz manifest.txt | sha256sum -c -
tar xzf lnd.tar.gz && export PATH="$PWD/lnd-linux-amd64-v0.21.3-beta:$PATH"

lnd --lnddir=~/.solvent-regtest/lnd-one --bitcoin.active --bitcoin.regtest --bitcoin.node=bitcoind \
  --bitcoind.rpchost=127.0.0.1:18443 --bitcoind.rpcuser=solvent --bitcoind.rpcpass=solvent-regtest-only \
  --bitcoind.zmqpubrawblock=tcp://127.0.0.1:28332 --bitcoind.zmqpubrawtx=tcp://127.0.0.1:28333 \
  --rpclisten=127.0.0.1:10009 --restlisten=127.0.0.1:8080 --listen=127.0.0.1:9735 \
  --noseedbackup --accept-keysend --protocol.wumbo-channels &

lnd --lnddir=~/.solvent-regtest/lnd-two --bitcoin.active --bitcoin.regtest --bitcoin.node=bitcoind \
  --bitcoind.rpchost=127.0.0.1:18443 --bitcoind.rpcuser=solvent --bitcoind.rpcpass=solvent-regtest-only \
  --bitcoind.zmqpubrawblock=tcp://127.0.0.1:28332 --bitcoind.zmqpubrawtx=tcp://127.0.0.1:28333 \
  --rpclisten=127.0.0.1:10010 --restlisten=127.0.0.1:8081 --listen=127.0.0.1:9736 \
  --noseedbackup --accept-keysend &
```

Fund LND-2 and open a channel to LND-1 — see the exact commands in `.github/workflows/real-cashu-integration.yml`'s "Fund LND-2 and open a real regtest channel" step (reproduced there verbatim; not duplicated here to avoid the two copies drifting apart — always prefer the workflow file as the source of truth).

### 3. The real CDK mint

```bash
mkdir -p /tmp/cdk && cd /tmp/cdk
curl -sSL -o cdk-mintd https://github.com/cashubtc/cdk/releases/download/v0.18.1/cdk-mintd-0.18.1-x86_64
curl -sSL -o SHA256SUMS https://github.com/cashubtc/cdk/releases/download/v0.18.1/SHA256SUMS
grep cdk-mintd-0.18.1-x86_64 SHA256SUMS | sha256sum -c -
chmod +x cdk-mintd
```

Write a `config.toml` with `[payment_backend] backend = "lnd"` pointed at LND-1's real `tls.cert`/`admin.macaroon` — exact shape in `.github/workflows/real-cashu-integration.yml`'s "Start CDK mint" step. `cdk-mintd` 0.18.x moved to database-backed configuration, so `--config` is a legacy/migration-only flag, not a startup input — import the config once, then start with no subcommand:

```bash
mkdir -p /tmp/cdk/mint
CDK_MINTD_MNEMONIC="<your own test mnemonic>" cdk-mintd --work-dir /tmp/cdk/mint \
  config init --new-mint --file config.toml
CDK_MINTD_MNEMONIC="<your own test mnemonic>" cdk-mintd --work-dir /tmp/cdk/mint &
```

Wait for `curl http://127.0.0.1:8085/v1/info` to succeed.

### 4. Run the Phase 1 integration test

```bash
export CDK_MINT_URL=http://127.0.0.1:8085
export LND_SOURCE_REST_URL=https://127.0.0.1:8081
export LND_BACKEND_REST_URL=https://127.0.0.1:8080
export LND_SOURCE_MACAROON_HEX=$(xxd -p -c 10000 ~/.solvent-regtest/lnd-two/data/chain/bitcoin/regtest/admin.macaroon)
export LND_BACKEND_MACAROON_HEX=$(xxd -p -c 10000 ~/.solvent-regtest/lnd-one/data/chain/bitcoin/regtest/admin.macaroon)
export NODE_TLS_REJECT_UNAUTHORIZED=0   # regtest self-signed certs only

npm run verify:cashu-real
```

Expect the exact CLI output documented in `DECISIONS.md`'s Phase 1 entry, ending in `REAL CASHU FOUNDATION VERIFIED` (exit 0) or an explicit, itemized `PHASE 1 NOT VERIFIED — <reason>` (non-zero exit).

### 5. Process-restart persistence check

Kill the `cdk-mintd` process from step 3, then start it again against the SAME `--work-dir` (same on-disk SQLite database, no `config init` needed the second time), and confirm the already-spent proofs from step 4 are still SPENT afterward:

```bash
kill %1   # or the cdk-mintd job/PID from step 3
CDK_MINTD_MNEMONIC="<the same test mnemonic as step 3>" cdk-mintd --work-dir /tmp/cdk/mint &
# wait for curl http://127.0.0.1:8085/v1/info to succeed again, then:
npm run verify:cashu-real:restart
```

Expect `REAL CASHU FOUNDATION RESTART PERSISTENCE VERIFIED` (exit 0). This is confirmed by real execution — see [run 35853398175](https://github.com/TheWeirdDee/solvent/actions/runs/35853398175) (2026-09-23), where both this and step 4 passed for real in GitHub Actions.

## C. Reproducing Phase 2's patched mint (real receipt signing, recovery, and retrieval)

Steps 1-2 above (Bitcoin Core regtest, two real LND nodes) are unchanged. Step 3 changes: instead of downloading the prebuilt release binary, `cdk-mintd` is built from source with SOLVENT's real patch series applied, exactly as `.github/workflows/real-cashu-integration.yml`'s "Clone pinned CDK 0.18.1, apply SOLVENT's real patch series, build cdk-mintd from source" step does — always prefer that workflow step as the source of truth over reproducing it here, to avoid the two copies drifting apart. In outline: clone `cashubtc/cdk`, `git checkout` the pinned commit (`a056e0f0f69e94f431b1aeb90d883f18c61ea4c6`, tag `v0.18.1`), verify the checked-out SHA matches, apply `patches/cdk/0001` through `0005` in order (`git apply --check` then `git apply` for each), then `cargo build -p cdk-mintd --no-default-features --features sqlite,lnd,management-rpc,info-page,bdk` (requires `protoc` — `apt-get install protobuf-compiler` on Linux/WSL2). The resulting binary replaces the downloaded one in step 3 above; steps 4-5 (Phase 1's integration test and restart check) still apply unchanged, plus the new Step 8 closure checks: `npm run verify:pol-seed-pending` / `verify:pol-recovery` (real receipt recovery across a real restart), `verify:pol-crash-trigger` (paired with a real `kill -9` and `SOLVENT_TEST_DELAY_BEFORE_COMMIT_MS=5000` — see `.github/workflows/real-cashu-integration.yml`'s "Real crash drill" step for the exact orchestration), and `verify:pol-wallet` (real wallet receipt retrieval and verification). Full architecture and crash-window reasoning: `docs/receipt-lifecycle.md` and `docs/crash-consistency.md`.

## No missing private code, no undocumented manual steps

Every command above is either literally copy-pasteable or points at the exact workflow step that has the literal command. No step requires anything not in this public repository — no "message me for config," no manual database edits. If reproducing this ever requires an undocumented step, that is a bug in this documentation, not an expected gap.
