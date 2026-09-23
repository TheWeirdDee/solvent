# INVARIANTS — Phase 2 mint-native accounting

Hard invariants Phase 2's durable SOLVENT accounting must satisfy against real CDK operations (`docs/cdk-integration-seams.md`, `docs/accounting-model.md`). Written before implementation, per Phase 2 Step 5. Every Phase 2 test should reference the invariant it proves; this file is the index those tests point back to, not a test report itself — see `docs/crash-consistency.md` for the crash-drill evidence and the real CI workflow for where each invariant is actually exercised.

**P2-I1** — Every successfully issued Cashu output has exactly one durable issued-liability accounting record.

**P2-I2** — No issued-liability record exists for a NUT-04 issuance that never committed.

**P2-I3** — Every proof successfully consumed by a swap or successful melt has exactly one durable consumed-liability record.

**P2-I4** — A failed swap creates no successful issued/spent accounting transition.

**P2-I5** — A failed melt does not finalize a consumed liability.

**P2-I6** — Every replacement output created by a successful swap becomes a new issued liability.

**P2-I7** — With fees disabled, a swap conserves net outstanding liability.

**P2-I8** — Successful melt reduces outstanding liability by exactly the consumed amount, with returned Cashu change treated as newly issued liability.

**P2-I9** — Retrying an already-committed operation cannot duplicate accounting.

**P2-I10** — Restart cannot lose committed accounting.

**P2-I11** — A successful Cashu operation cannot create spendable value without a durable SOLVENT accounting obligation.

**P2-I12** — Mint private amount keys never leave the mint/signatory boundary.

**P2-I13** — Receiver secrets, proof secrets, and wallet identity are not written into public accounting evidence.

**P2-I14** — Retired keysets with outstanding proofs remain part of outstanding liabilities.

## Status

Not yet implemented or tested — this file defines the target, per Phase 2 Step 5's explicit "before implementation" ordering. `docs/cdk-integration-seams.md`'s SQL-trigger architecture (`DECISIONS.md`'s Phase 2 Step 2 entry) is designed specifically so P2-I1 through P2-I3, P2-I9, and P2-I10 hold by construction (the trigger fires inside CDK's own commit, so there is no window for CDK to commit without the corresponding row, no separate "later" write to lose on crash, and no separate retry path to duplicate it). P2-I4 through P2-I8 and P2-I14 depend on correctly distinguishing a saga's *provisional* commits (e.g. `setup_swap()`/`setup_melt()` locking proofs as pending) from its *terminal* commit (`finalize()`) — see `docs/cdk-integration-seams.md`'s NUT-03/NUT-05 sections for exactly which CDK transaction is which. P2-I11 is the composite property the whole architecture exists to guarantee. P2-I12 is not yet satisfiable by the SQL-trigger seam alone — see `docs/pol-extension.md`'s open question about `cdk-signatory`. P2-I13 is Phase 2 Step 17's privacy audit, not yet performed.
