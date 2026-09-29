# Pre-push gate

Run all of these before pushing any change that touches the verifier, the epoch closer, the CDK patches or the real-Cashu CLIs. CI runs the real-LND equivalents, but only after a push, and a regression found there costs a full CI cycle.

```sh
npm run typecheck
npm test
npm run build
npm run attacks            # then: git checkout -- evidence/attacks  (the run rewrites them)
npm run verify:submission
npm run verify:ui:browser -- http://localhost:4173/   # against `npx vite preview --port 4173`

# Against a running local patched cdk-mintd (patches 0001-0008, migrations 0001-0003;
# fakewallet is fine here — see docs/reproduce-real-stack.md):
CDK_MINT_URL=http://127.0.0.1:8085 \
SOLVENT_MANIFEST_PRIVKEY=<the mint's manifest key> \
SOLVENT_MANIFEST_DELEGATION=<cdk-mintd solvent delegate-manifest-key output for it> \
  npm run verify:pol-epoch -- <work-dir>/cdk-mintd.sqlite

npm run verify:phase3b-evidence -- evidence/real-pol/phase3b-local-fakewallet
```

When a CDK patch changed, also:

- apply `patches/cdk/*.patch` in order to a clean LF checkout of the pinned CDK commit (`CDK_COMMIT` in `.github/workflows/real-cashu-integration.yml`);
- run `cargo test -p cdk-signatory --lib` and build `cdk-mintd` from that tree.

`verify:pol-epoch` is the check most easily forgotten, because it needs a running mint. It is also the only local check that drives the central verifier with a real mint's authority chain (NUT-06 identity, delegation, keyset count).
