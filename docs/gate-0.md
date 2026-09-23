# Gate 0 — NUT-12 transfer invariant

**Result: PASS.** Run `npx tsx src/cashu/gate0.ts` to reproduce; evidence is written to `evidence/gate-0/`.

## Question

Does a real Cashu proof, pushed through the actual library's wallet-to-wallet transfer serialization, still carry usable NUT-12 `(e, s, r)` on the receiving side — and can the receiver, using only what arrived on the wire plus the mint's public per-amount key, independently reconstruct the exact `B'` the mint signed at issuance?

## What was used

- **Library:** `@cashu/cashu-ts` `4.10.2` (the only Cashu library in this repo; no other candidate was evaluated).
- **Issuance-side primitives (real, not hand-authored):** `blindMessage`, `createBlindSignature`, `createDLEQProof`, `constructUnblindedSignature`, `createRandomSecretKey`, `getPubKeyFromPrivKey`.
- **Transfer path (the actual thing being tested):** `getEncodedToken(token)` → a real Cashu token string → `getDecodedToken(tokenString, keysetIds)`. No `removeDleq` option was passed.
- **Receiver-side reconstruction (real, independent of the issuance step's in-memory values):** `hashToCurve(secret)` for `Y`, `pointFromHex` for EC point arithmetic (`B' = Y + rG`, `C' = C + rA`), `hasValidDleq` for the DLEQ check.

## Findings

1. **No explicit "include DLEQ" option was required.** `getEncodedToken`'s only relevant option is `removeDleq?: boolean`, which is opt-in *removal*, not opt-in inclusion. DLEQ data survives serialization by default.
2. **`receive` preserved `r` automatically.** The decoded proof's `dleq.r` was present and numerically identical to what was attached at issuance — no library flag, no manual re-attachment.
3. **Reconstructed `B'` exactly equals the original issuance-side `B'`**, and reconstructed `C'` exactly equals the mint's original `C_`. Both were computed on the "receiver" side from nothing but the decoded proof (`secret`, `C`, `dleq.r`) and the mint's public per-amount key `A` — never by reading the issuance-side in-memory variables.
4. **DLEQ verified** via `hasValidDleq(receivedProof, { id, keys }, { require: true })` against the correct per-amount public key.

## One caveat worth naming

`hasValidDleq` expects its second argument as `{ id, keys }`, not a bare `Keys` map — passing the raw map throws inside the library (`Cannot convert undefined or null to object`, since it tries to read `.keys` off what it received). This is a call-shape detail, not a library defect; documented here so it isn't rediscovered the hard way in Gate 1+.

## Generator point

`B' = Y + rG` requires the secp256k1 generator point `G`. `@cashu/cashu-ts` does not re-export it directly (it's used internally as `Point.BASE`), so `gate0.ts` reconstructs it from its well-known compressed SEC1 encoding (`0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798` — the same constant that appears as the amount-`1` public key in the official NUT-12 test vectors, since `1 * G = G`) via `pointFromHex`. This is a fixed public curve parameter, not invented cryptography.

## Conclusion

Gate 0 passes without any mechanism change, fallback, or opaque-ID substitution. The hero mechanism's foundational assumption — a holder can reconstruct the exact `B'` a mint signed, from ecash that has genuinely been transferred wallet-to-wallet — holds under the real library path. Proceeding to Gate 1.
