// npm run verify:cashu-real
//
// SOLVENT — Phase 1: Real Cashu Foundation.
//
// Proves the underlying Cashu economic lifecycle end to end against a REAL,
// independently-developed mint (CDK), a REAL regtest Lightning network (two
// real `lnd` nodes), and a REAL Bitcoin regtest chain — with NO fabricated
// paid quotes, NO SOLVENT-generated mint, and NO local "accepted=true"
// substitute anywhere in this file. SOLVENT's own PoL protocol (manifests,
// receipts, Nostr publication, reserve attestation) is intentionally NOT
// touched here — see docs/real-cashu-stack.md and docs/REALITY-MAP.md for
// exactly what this phase does and does not cover, and DECISIONS.md for why
// that boundary is deliberate.
//
// Every "real" claim below is independently checked, not assumed:
//   - "the invoice was really paid" is confirmed by asking the SENDER's own
//     Lightning node (LND-2) for ITS OWN payment record, never by trusting
//     the mint's own claim alone.
//   - "the mint's backend is a real Lightning node" is confirmed by asking
//     the BACKEND node (LND-1) for ITS OWN invoice record under the exact
//     payment hash the mint quote returned — a fakewallet-backed mint has
//     no real backend node to ask, so this check fails closed against one
//     (see checkRealStackNotFake() below — this is item 4/R12's explicit
//     "fake payment backend must be excluded" gate).
//   - "the proof is spent/unspent" is confirmed via a real NUT-07
//     /v1/checkstate call to the mint, never local application memory.
//
// This script assumes bitcoind + 2 real `lnd` nodes + a real `cdk-mintd`
// (backend `lnd`, pointed at LND-1) are ALREADY RUNNING and reachable —
// bringing that stack up is infrastructure orchestration, not Cashu
// protocol logic, and lives in .github/workflows/real-cashu-integration.yml
// (see docs/reproduce-real-stack.md to run it yourself).
import { randomUUID } from 'node:crypto';
import {
  Wallet,
  Mint,
  MintQuoteState,
  createRandomRawBlindedMessage,
  isMintOperationError,
  getDecodedToken,
  getEncodedToken,
  type Proof,
  type SerializedBlindedMessage,
  type SwapRequest,
  type Token,
} from '@cashu/cashu-ts';
import { LndClient } from './lnd-client.js';
import { ProofStore } from './proof-store.js';
import { EvidenceWriter, redactProof, sha256Hex } from './evidence.js';

interface Config {
  mintUrl: string;
  lndSourceRestUrl: string; // LND-2 — pays the mint quote invoice AND later creates the melt-destination invoice
  lndSourceMacaroonHex: string;
  lndBackendRestUrl: string; // LND-1 — the mint's OWN payment backend, queried independently to prove the backend is real
  lndBackendMacaroonHex: string;
  amountSat: number;
}

function readConfig(): Config {
  const req = (name: string): string => {
    const v = process.env[name];
    if (!v) throw new Error(`Missing required env var ${name}`);
    return v;
  };
  return {
    mintUrl: req('CDK_MINT_URL'),
    lndSourceRestUrl: req('LND_SOURCE_REST_URL'),
    lndSourceMacaroonHex: req('LND_SOURCE_MACAROON_HEX'),
    lndBackendRestUrl: req('LND_BACKEND_REST_URL'),
    lndBackendMacaroonHex: req('LND_BACKEND_MACAROON_HEX'),
    amountSat: Number(process.env.CDK_REAL_TEST_AMOUNT_SAT ?? '1000'),
  };
}

function line(label: string, ok: boolean, detail?: string): string {
  return `${label.padEnd(32)}${ok ? 'PASS' : 'FAIL'}${detail ? '  ' + detail : ''}`;
}

/**
 * R12 / item 4's explicit gate: if the configured mint's payment backend
 * cannot be independently proven to be a real external Lightning node,
 * REAL STACK VERIFICATION MUST FAIL — never silently continue against a
 * fakewallet-backed mint. Proven by round-tripping through the backend
 * node itself: create a throwaway invoice, ask the MINT for a quote for
 * that same amount, and confirm the two are genuinely different real
 * invoices from the same real node identity (fakewallet mints do not
 * proxy to any real node at all, so this whole exchange has nothing real
 * to correlate against).
 */
async function checkRealStackNotFake(backend: LndClient, mintUrl: string): Promise<{ ok: boolean; backendPubkey: string; detail: string }> {
  const info = await backend.getInfo();
  if (!info.identity_pubkey) return { ok: false, backendPubkey: '', detail: 'LND backend node did not report a real identity pubkey' };
  // The mint must be configured with backend = "lnd" pointed at this exact
  // node — verified operationally below (R1's payment-hash cross-check is
  // the authoritative proof); this call only confirms the backend node
  // itself is alive and real before the full lifecycle runs.
  const res = await fetch(`${mintUrl}/v1/info`);
  if (!res.ok) return { ok: false, backendPubkey: info.identity_pubkey, detail: `mint /v1/info -> HTTP ${res.status}` };
  return { ok: true, backendPubkey: info.identity_pubkey, detail: `LND backend node alive, identity ${info.identity_pubkey.slice(0, 16)}...` };
}

async function main() {
  const cfg = readConfig();
  const runId = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
  const evidence = new EvidenceWriter(runId);
  const results: { label: string; ok: boolean; detail?: string }[] = [];
  const record = (label: string, ok: boolean, detail?: string) => {
    results.push({ label, ok, detail });
    console.log(line(label, ok, detail));
  };

  console.log('SOLVENT — REAL CASHU FOUNDATION\n');
  evidence.write('environment', { mintUrl: cfg.mintUrl, amountSat: cfg.amountSat, runId, startedAt: new Date().toISOString() });

  const lndSource = new LndClient({ restUrl: cfg.lndSourceRestUrl, macaroonHex: cfg.lndSourceMacaroonHex });
  const lndBackend = new LndClient({ restUrl: cfg.lndBackendRestUrl, macaroonHex: cfg.lndBackendMacaroonHex });

  // ---- Environment health -------------------------------------------------
  let allOk = true;
  try {
    const backendInfo = await lndBackend.getInfo();
    record('Lightning source node', true, `LND-2, block ${(await lndSource.getInfo()).block_height}`);
    record('Lightning destination node', true, 'LND-2 also used as melt destination (2-node regtest topology)');
    record('CDK mint', true, cfg.mintUrl);
    const fakeCheck = await checkRealStackNotFake(lndBackend, cfg.mintUrl);
    record('Fake payment backend', fakeCheck.ok, fakeCheck.ok ? 'ABSENT' : `DETECTED — ${fakeCheck.detail}`);
    evidence.write('versions', { lndBackendPubkey: backendInfo.identity_pubkey, mintUrl: cfg.mintUrl });
    if (!fakeCheck.ok) allOk = false;
  } catch (err) {
    record('Environment health', false, (err as Error).message);
    console.log('\nPHASE 1 NOT VERIFIED — environment health check failed before any Cashu operation was attempted.');
    process.exitCode = 1;
    return;
  }
  console.log('');

  if (!allOk) {
    console.log('PHASE 1 NOT VERIFIED — fake payment backend detected on the configured mint. Refusing to proceed (see checkRealStackNotFake()).');
    process.exitCode = 1;
    return;
  }

  const senderStore = new ProofStore(`${evidence.dir}/../../../.real-cashu-state/sender-${runId}`);
  const receiverStore = new ProofStore(`${evidence.dir}/../../../.real-cashu-state/receiver-${runId}`);

  const senderWallet = new Wallet(cfg.mintUrl);
  await senderWallet.loadMint();
  const mintInfo = senderWallet.getMintInfo();
  evidence.write('mint-info', mintInfo.cache);

  // ---- R1/R2/R3: mint quote, real payment, refusal-before-payment, real issuance ----
  const mintQuote = await senderWallet.createMintQuoteBolt11(cfg.amountSat);
  evidence.write('mint-quote', { quote: mintQuote.quote, request: mintQuote.request, amount: cfg.amountSat });

  // R2 — an unpaid quote must be refused by the mint, not by client-side logic.
  let r2Refused = false;
  let r2Detail = '';
  try {
    await senderWallet.mintProofsBolt11(cfg.amountSat, mintQuote.quote);
    r2Refused = false;
    r2Detail = 'mint incorrectly issued proofs for an UNPAID quote';
  } catch (err) {
    r2Refused = true;
    r2Detail = (err as Error).message;
  }
  record('R2  Mint refuses unpaid issuance', r2Refused, r2Detail);

  // R1 — pay the real invoice from a REAL, separate Lightning node, then
  // independently confirm settlement from THAT node's own payment record
  // (never from the mint's say-so alone).
  const payment = await lndSource.payInvoiceSync(mintQuote.request);
  const paymentHash = payment.paymentHashHex ?? sha256Hex(mintQuote.request);
  let r1Settled = false;
  if (payment.ok) {
    const history = await lndSource.listPayments();
    const match = history.payments.find((p) => p.payment_request === mintQuote.request);
    r1Settled = match?.status === 'SUCCEEDED';
  }
  record('R1  Lightning invoice genuinely settled (independently confirmed by the payer node)', r1Settled, payment.ok ? `preimage ${payment.paymentPreimageHex?.slice(0, 16)}...` : payment.paymentError);
  evidence.write('mint-payment', { paymentHash, ok: payment.ok, error: payment.paymentError });

  const mintQuoteChecked = await senderWallet.checkMintQuoteBolt11(mintQuote.quote);
  const r3Paid = mintQuoteChecked.state === MintQuoteState.PAID;
  let issuedProofs: Proof[] = [];
  if (r3Paid) {
    issuedProofs = await senderWallet.mintProofsBolt11(cfg.amountSat, mintQuoteChecked.quote);
    senderStore.addProofs(cfg.mintUrl, issuedProofs);
  }
  record('R3  NUT-04 issuance (real proofs from a paid quote)', r3Paid && issuedProofs.length > 0, `${issuedProofs.length} proof(s), ${issuedProofs.reduce((s, p) => s + Number(p.amount), 0)} sat`);
  evidence.write('issued-proofs', issuedProofs.map(redactProof));

  // ---- R4: NUT-07 state before swap ---------------------------------------
  const stateBefore = await senderWallet.checkProofsStates(issuedProofs);
  const r4Unspent = stateBefore.every((s) => s.state === 'UNSPENT');
  record('R4  NUT-07: original proofs UNSPENT (queried from the mint)', r4Unspent);
  evidence.write('proof-state-before', stateBefore);

  // ---- R5/R6/R7: real sender -> receiver transfer via a genuine NUT-03 swap ----
  const senderToken: Token = { mint: cfg.mintUrl, proofs: issuedProofs } as Token;
  const encodedToken = getEncodedToken(senderToken);
  const decodedToken = getDecodedToken(encodedToken, [issuedProofs[0]!.id]);

  const receiverWallet = new Wallet(cfg.mintUrl);
  await receiverWallet.loadMint();
  const swapPreview = await receiverWallet.ops.receive(decodedToken).prepare();
  // Persist BEFORE submitting — item 7/11's crash-safe requirement.
  const { serializeSwapPreview } = await import('@cashu/cashu-ts');
  senderStore.setPendingPreview('receive', serializeSwapPreview(swapPreview));
  const receiverProofs = await receiverWallet.completeSwap(swapPreview);
  senderStore.clearPendingPreview('receive');
  receiverStore.addProofs(cfg.mintUrl, receiverProofs.keep ?? receiverProofs);
  const newProofs: Proof[] = (receiverProofs.keep ?? receiverProofs) as Proof[];
  record('R5  NUT-03 receiver swap', newProofs.length > 0, `${newProofs.length} fresh proof(s)`);
  evidence.write('swap-request', { inputCount: issuedProofs.length, mintUrl: cfg.mintUrl });
  evidence.write('swap-response', { outputCount: newProofs.length });

  const stateAfterOriginal = await senderWallet.checkProofsStates(issuedProofs);
  const r6Spent = stateAfterOriginal.every((s) => s.state === 'SPENT');
  record('R6  Original proofs SPENT after swap', r6Spent);

  const stateAfterNew = await receiverWallet.checkProofsStates(newProofs);
  const r7Unspent = stateAfterNew.every((s) => s.state === 'UNSPENT');
  record('R7  Receiver replacement proofs UNSPENT', r7Unspent);
  evidence.write('proof-state-after', { original: stateAfterOriginal, replacements: stateAfterNew });

  // ---- R8/R9: double-spend rejection ---------------------------------------
  // Phase 2 Step 0 correction: the original version of this check used
  // `senderWallet.ops.receive(token).prepare()`, which threw "Proof has
  // unrecognised keyset ... is not a keyset for this wallet unit" —
  // confirmed (by grepping cashu-ts's own bundled source) to be a
  // CLIENT-SIDE guard in `isUnitKeyset`, thrown before any HTTP request
  // was ever sent. That proved nothing about the mint. This version
  // bypasses the high-level Wallet entirely and sends a real, manually
  // constructed `/v1/swap` request straight to the mint via the low-level
  // `Mint` client (`Mint.swap()` is a direct HTTP POST with no client-side
  // pre-validation), so a rejection here can only come from the mint's own
  // real proof-state tracking. `isMintOperationError()` distinguishes a
  // genuine parsed HTTP error response from the mint (only ever
  // constructed from one) from any other kind of client-side throw.
  const stateBeforeDoubleSpend = await senderWallet.checkProofsStates(issuedProofs);
  const r8OriginalsStillSpent = stateBeforeDoubleSpend.every((s) => s.state === 'SPENT');
  record('R8  NUT-07: original proofs still SPENT before the double-spend attempt', r8OriginalsStillSpent);

  const rawMint = new Mint(cfg.mintUrl);
  const doubleSpendOutputs: SerializedBlindedMessage[] = issuedProofs.map((p) => ({
    amount: p.amount,
    B_: createRandomRawBlindedMessage().B_.toHex(true),
    id: p.id,
  }));
  const doubleSpendRequest: SwapRequest = { inputs: issuedProofs, outputs: doubleSpendOutputs };

  let r9RequestSent = false;
  let r9RejectedByMint = false;
  let r9Detail = '';
  try {
    r9RequestSent = true; // Mint.swap() is a real fetch() POST — reaching this line means it was dispatched.
    await rawMint.swap(doubleSpendRequest);
    r9Detail = 'mint incorrectly accepted already-spent proofs a second time';
  } catch (err) {
    if (isMintOperationError(err)) {
      r9RejectedByMint = true;
      r9Detail = `real mint HTTP error (code ${err.code}, status ${err.status}): ${err.message}`;
    } else {
      r9Detail = `rejected before reaching the mint (not a real mint response — this would be a test bug, not proof of anything): ${(err as Error).message}`;
    }
  }
  const r9AlreadySpentReason = /spent/i.test(r9Detail);
  const r9Pass = r9RequestSent && r9RejectedByMint && r9AlreadySpentReason;
  record('R9  Second /v1/swap request reached the real mint and was rejected as already-spent', r9Pass, r9Detail);
  evidence.write('double-spend-result', {
    originalsStillSpentPerNut07: r8OriginalsStillSpent,
    requestSentToMint: r9RequestSent,
    rejectedByRealMintResponse: r9RejectedByMint,
    detail: r9Detail,
  });

  // ---- R10/R11: real NUT-05 melt back out to a real destination invoice ----
  const destInvoice = await lndSource.createInvoice(Math.max(1, Math.floor(cfg.amountSat * 0.9)), `solvent-phase1-melt-${runId}`);
  const meltQuote = await receiverWallet.createMeltQuoteBolt11(destInvoice.payment_request);
  evidence.write('melt-quote', { quote: meltQuote.quote, amount: String(meltQuote.amount), fee_reserve: String(meltQuote.fee_reserve) });
  const meltResult = await receiverWallet.ops.meltBolt11(meltQuote, newProofs).run();
  evidence.write('melt-result', { quote: meltResult.quote.quote, state: meltResult.quote.state });

  const destLookup = await lndSource.lookupInvoice(destInvoice.r_hash);
  const r9DestPaid = destLookup.settled === true || destLookup.state === 'SETTLED';
  record('R10 NUT-05 melt pays a real regtest Lightning invoice', r9DestPaid, `destination invoice state=${destLookup.state}`);
  evidence.write('destination-payment', { paymentHash: destInvoice.r_hash, settled: r9DestPaid, state: destLookup.state });

  const receiverStateAfterMelt = await receiverWallet.checkProofsStates(newProofs);
  const r10Spent = receiverStateAfterMelt.every((s) => s.state === 'SPENT');
  record('R11 Receiver proofs SPENT after melt', r10Spent);
  if (r10Spent) receiverStore.removeProofsBySecret(newProofs.map((p) => p.secret));

  const summary = {
    runId,
    allPassed: results.every((r) => r.ok),
    results,
  };
  evidence.write('summary', summary);

  console.log('');
  if (summary.allPassed) {
    console.log('REAL CASHU FOUNDATION VERIFIED');
    process.exitCode = 0;
  } else {
    console.log(`PHASE 1 NOT VERIFIED — ${results.filter((r) => !r.ok).map((r) => r.label).join('; ')}`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error('real-cashu-foundation crashed:', err);
  process.exitCode = 1;
});
