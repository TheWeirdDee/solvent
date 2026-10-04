# Railway staging — the real-Lightning candidate on Railway itself, 2026-10-03

The uncommitted candidate (working tree on `2d10156`) deployed with `railway up` to an **isolated Railway environment**, `staging-ldk`, in the same project as production. Real Mutinynet Lightning (LDK node inside `cdk-mintd`), Mutinynet test sats only. **Production was not touched**: its service, variables, volume and domains were only read.

## Isolation

| | Staging | Production |
|---|---|---|
| Environment | `staging-ldk` (created empty, not duplicated) | `production` |
| Service | `solvent-staging-ldk` | `solvent` |
| Volume | `solvent-staging-ldk-volume` at `/data` | `solvent-volume` at `/data` |
| Mint | `https://solvent-staging-ldk-staging-ldk.up.railway.app/v1/info` | `https://solvent-production-2029.up.railway.app/v1/info` |
| Evidence service | `https://solvent-staging-ldk-staging-ldk-9934.up.railway.app` | `https://solvent-production-9c92.up.railway.app` |
| NUT-06 identity | `03c05624a37fe2c17b7ec6fe07e5ea90ba86ec81209499d45fb3d97cf871dff510` | `0294d5b0…743dd7` |
| Lightning | `ldk-node`, node `02ba162d958e96c514bfecae0605f25466a934fd31482576ea8778f1a1acfdf76c` | fakewallet |
| Reserve | the published Mutinynet **test** reserve `598bfed2…58fb:0` | its own reserve |

Staging's mint seed, LDK seed, manifest key and Nostr key were generated for staging, set as Railway variables from stdin, and never printed or written to disk; each was checked to differ from production's.

## Railway build ([`railway-build-facts.txt`](railway-build-facts.txt))

Railway's builder built `deploy/railway/Dockerfile` with `--features sqlite,lnd,ldk-node,fakewallet` (Rust compile 2 m 16 s; upload to healthy ≈ 4.5 min). The first upload was built by Railpack as a Vite static site — the documented failure — because the new service had no Dockerfile path; setting the staging service's Dockerfile path (as production has it) fixed it.

## Lightning

The staging node was funded with 400,000 Mutinynet test sats from the public faucet and opened a 300,000-sat announced channel to **Faucet LND** (`02465ed5…afb1b`), 150,000 pushed: channel `582c746a1da82f58835952db4e6a358534dfa177289c58cd44744eff2648cd25`, active ~4 min after opening, visible on the public Mutinynet graph.

Every staging invoice was paid by **the Mutinynet faucet's Lightning node** (`faucet.mutinynet.com`, the path a judge uses) over that public channel; every melt paid a faucet invoice the other way. Two independent LDK test wallets could **not** find a route to the new channel for over 50 minutes (their peer-to-peer gossip had not learned it); see "Finding" below.

## Runs ([`runs/`](runs/), [`logs/`](logs/))

| Run | Browser | Checks | Honest | Swap (liability) | Melt (liability) | Broken promise |
|---|---|---|---|---|---|---|
| run1 | Chromium 1363×936 | 43/43 | `ACCEPT_VERIFIED` | VERIFIED (64 → 64) | VERIFIED (64 → 24) | `REFUSE_ISSUANCE_OMITTED` |
| run2 | Chromium 390×844 | 43/43 | `ACCEPT_VERIFIED` | VERIFIED (152 → 152) | VERIFIED (152 → 112) | `REFUSE_ISSUANCE_OMITTED` |
| run3 | WebKit 390×844 | 43/43 | `ACCEPT_VERIFIED` | VERIFIED (240 → 240) | VERIFIED (240 → 200) | `REFUSE_ISSUANCE_OMITTED` |
| run4 (after redeploy) | Chromium 1363×936 | 43/43 | `ACCEPT_VERIFIED` | VERIFIED (328 → 328) | VERIFIED (328 → 288) | `REFUSE_ISSUANCE_OMITTED` |

Each run also: verified the fresh Nostr events outside the app; checked NUT-07 from Node (old proofs `SPENT`, replacements and change `UNSPENT`); recomputed the spent sum-MMR inclusion and sha256(preimage) = payment hash outside the app; exercised the relay-outage → retry path and exactly-once acceptance. Every record says `lightning_backend: ldk-node`; the staging logs contain no fakewallet line.

## Redeploy ([`state/`](state/))

`railway redeploy` of the staging service (a new deployment, same volume): identity, keyset, LDK node, channel, epochs (open 16 / last published 15), 15 publication records and the earlier swap's spent-side evidence all unchanged; all 15 closed epochs re-derive from the database with no failure; no force-close, panic or corruption line. Mint answering ~2 s after the deployment went healthy; channel active within ~10 s. Run 4 then passed in full.

## Railway resources ([`railway-metrics.txt`](railway-metrics.txt))

Railway's own metrics for the staging service: memory median 326 MB, **peak 379 MB** (38 % of the 1 GB limit); CPU median 0.003 vCPU, peak 0.036 vCPU (2 vCPU limit); disk ≤ 57 MB. Memory rose from ~150 MB at start to ~370 MB during the runs and returned to ~190 MB after the redeploy — worth watching in production.

## Finding: routing to a new channel

Payers that keep their own graph through LDK's peer-to-peer gossip did not learn the staging channel within 50 minutes. Payments from the faucet (the mint's direct channel peer) needed no pathfinding and worked at once. For the public deployment the judge's path is the faucet, so this does not block it; a wallet with a stale graph may fail until the channel propagates.
