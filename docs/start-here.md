# Start here — try SOLVENT in 2 minutes

This is the fastest way to see SOLVENT actually decide something, entirely in your browser — no terminal, no manual JSON, no account.

## Part 1 — see a real ACCEPT (the Live Public Demo)

1. Go to **[Verify](#/verify)**. You land on the "Try SOLVENT" tab.
2. Click the **LIVE PUBLIC DEMO** case, then **Run verification**.
3. Watch the nine-step decision chain run for real: token origin, the blind-signature proof, the mint's receipt, the accounting period, the published accounting record, whether the issuance was actually included, public evidence, and a live re-query of the real Bitcoin reserve.
4. Step 7, "Public evidence," is doing something specific: SOLVENT is genuinely querying real public Nostr relays right now for this exact accounting record — not just checking a signature on a copy it was handed. Open **"View evidence"** and look for **Relay: REACHABLE** and **Exact event: FOUND (public relay)**.
5. You'll land on **ACCEPT VERIFIED** — every check passed, including a reserve figure just fetched from the real chain and an accounting record just fetched from a real public relay, right now.
6. Click **Accept ecash**. This calls SOLVENT's real acceptance function — a genuine, observable state change, not a UI animation. You'll see the acceptance record: mint, amount, a token fingerprint, and confirmation the accept function was called exactly once.

This case works because SOLVENT published this one evidence set to real public relays, once, ahead of time (`npm run live-demo` — see `docs/trust-boundaries.md`'s "Live Public Demo" section for the exact event id, relays, and digests). Every run independently re-fetches and re-verifies it live; nothing about the ACCEPT is precomputed or cached.

## Part 2 — see why a *private* signed copy isn't enough (Create Test Ecash)

7. Click the **"Create test ecash"** tab, then **Create test ecash**. SOLVENT's test mint issues one real blind-signed Cashu proof and a signed receipt promising to account for it — with a **brand-new identity**, to prove genuine fresh issuance. This takes a few seconds because it's doing real cryptography and a real live query, not returning a canned response.
8. You'll see your ecash: an encoded token, its amount, its keyset, and the mint identity. This token is a real, standards-compliant encoded Cashu proof — but it's issued by SOLVENT's own test mint, not a production one, so there's nothing to spend it against. See [the verification bundle schema](#/docs?doc=verification-bundle) — "Is this ecash real?" — for exactly what that does and doesn't mean.
9. Click **Verify this ecash**. Every gate passes — proof, receipt, epoch, manifest, inclusion, reserve — except one: this ecash's evidence was never published anywhere, so nobody but you has a copy of it. SOLVENT genuinely tries to fetch it from public relays anyway (same as Part 1) and, correctly, finds nothing — relays were reachable, the event simply isn't there (`REFUSE_NOSTR_EVENT_NOT_FOUND`, distinct from a relay being unreachable).
10. You land on **"CRYPTOGRAPHIC CHECK PASSED"** with a **"PUBLICATION NOT FOUND"** badge, not ACCEPT. **Accept ecash stays disabled.** This is intended: a mint handing you a validly signed promise privately is not the same as that promise being publicly checkable, which is SOLVENT's actual guarantee. Click **"Try live public demo"** to jump back to a case where publication genuinely is verified.

## Where does the bundle come from?

You never have to write one. "Create test ecash" builds it for you, using the same issuance and evidence machinery a real SOLVENT-compatible mint would use — signed receipts, a closed epoch manifest, a Bitcoin reserve attestation, and a signed Nostr event. If you want to check that the manual verifier ("Verify your evidence") genuinely works on real data, click **"Load example bundle"** there — it loads the same Live Public Demo bundle from Part 1 (not a static fixture), which reaches a real ACCEPT.

The bundle is never a claim about its own validity. It carries raw signed evidence, and SOLVENT independently re-derives whether that evidence actually checks out — a live Bitcoin re-query for the reserve, a live public-relay fetch and re-verification for the Nostr evidence — before it ever reaches a decision. See [the verification bundle schema](#/docs?doc=verification-bundle) for the full structure and why.

## Where to go next

- **[Protocol](#/protocol)** — the full technical decision chain, gate by gate.
- **[Trust boundaries](#/docs?doc=trust-boundaries)** — what this build proves, what it explicitly does not change, and the exact Live Public Demo record (event id, relays, digests).
- **[Attack corpus](#/docs?doc=attack-corpus)** — 25 adversarial cases, each run for real.
