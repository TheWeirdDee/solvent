# Production Mutinynet cutover and restart

Cutover began on 2026-10-04. The restart and post-restart verification completed on 2026-10-05. These are actual public browser runs against [SOLVENT](https://solvent-ashen.vercel.app/), not localhost or staging. Test sats have no monetary value.

| Run | Checks passed | Failed | Recorded (UTC) |
| --- | ---: | ---: | --- |
| [chromium-desktop](chromium-desktop.json) | 55 | 0 | 2026-10-04T19:38:12.352Z |
| [chromium-390](chromium-390.json) | 55 | 0 | 2026-10-04T22:09:56.826Z |
| [webkit-390](webkit-390.json) | 55 | 0 | 2026-10-05T03:48:12.013Z |
| [post-restart-chromium](post-restart-chromium.json) | 55 | 0 | 2026-10-05T16:01:43.712Z |

Every run paid fresh NUT-04 invoices from the separate Mutinynet faucet node, verified the signed promise, closed epoch, public Nostr and reserve, accepted exactly once, swapped through NUT-03, and paid a real 40-test-sat invoice through NUT-05. Independent checks confirm original/input proofs SPENT, replacements/change UNSPENT, conserved swap liability, signed spent inclusion, payment preimage, and the correct liability decrease. The deliberate omission produces REFUSE_ISSUANCE_OMITTED and zero acceptance calls. Relay unavailability accepts nothing; retry rechecks the same issuance.

The first WebKit attempt had two download assertions fail because the harness bypassed its existing scroll-stability helper. The corrected rerun above completed both downloads and the whole lifecycle. No production acceptance rule was relaxed.

## Deployment and state

- Mint: https://solvent-production-2029.up.railway.app
- Evidence: https://solvent-production-9c92.up.railway.app
- Original NUT-06 identity: `0294d5b02aafe6d7a9c35c5129628265bc02bd42cb6311e2435b123e1010743dd7`.
- Backend: real `ldk-node`, Bitcoin Signet/Mutinynet.
- LDK node: `025c6523810a230f4fd97752ea0fd00966a0856b4df3d6995caa87941a07fc6a93`.
- Channel: `1755e680b54aa7402d9d6e961a00e2e32b0717076a7bcda5dc0e9019bf27b6ed`, ACTIVE before and after restart; 300,000 test sats, initially 150,000 pushed for inbound liquidity.
- Funding: 400,000 test sats, transaction `87dbe39acb1bee7271ad7466b313a25a8b5e62c7387e263640feac5a660bccfd`.
- Channel funding transaction: `edb627bf19900edca5cd7b6a0717072be3e2001a966e9d2d40a74ab580e65517`.
- Reserve: `809e5190a63ea454d35fbb0b86919d6799fa65a6fe4385baa63eb180711308c2:1`, 1,000,000 test sats; original configuration preserved.

[Restart evidence](restart.json) compares full table counts/digests, the original 98 epoch rows, publication and delegation digests, mint identity, keysets, epochs, reserve, historical proof states and prior spend evidence. All comparisons match. All 117 nonzero closed epochs audited after restart pass. The same node/channel reconnected; no force close, panic or corruption was observed. One replica was configured; the old instance was removed. Sampled endpoint monitoring bounds the observed interruption to about 12 seconds, below the 20-minute operational window. No seed/state copy or database rollback was used. Staging remains running for independent audit.

## Provenance and reproduction

The backend runs `c3fae6862140cc1799d63f4e2d10331a7f4da3ea`; the post-restart frontend serves `99779ecdc9f8ec59b3e97e7e3ec76d93c0a70981`. A record's `git_commit` identifies the local harness checkout, not necessarily the deployed frontend. `working_tree_clean: false` is preserved truthfully. The earlier desktop and Chromium-phone records used the default-endpoint `- -` arguments; their URL metadata therefore contains `-`. The corrected harness records the endpoints observed in the page, including identity/backend, in WebKit and post-restart records. Earlier artifacts have not been rewritten.

```sh
npm run verify:real-mint:browser -- https://solvent-ashen.vercel.app/ - - --swap --melt --pay-faucet <private-token-file> --evidence-out <output.json>
# Phone variants: --width 390, and --browser webkit --width 390
```

Public values only: no mnemonic, private key, faucet credential, browser storage or spendable Cashu proof secret. Payment preimages are for completed test payments. This is a dated observation; live state continues to advance.
