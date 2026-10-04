// The live NUT-03 swap: ecash a visitor just had verified and accepted goes
// back to the SAME mint's real /v1/swap. The browser builds the replacement
// outputs itself (so it knows every blinded message B_ before the mint signs
// it), unblinds the mint's signatures, asks the mint's NUT-07 endpoint for the
// state of the old and new proofs, and then checks the mint's own accounting:
//
//   spent side   GET /v1/solvent/spend/<Y>      the consumed row, every row of
//                the same operation, and once the epoch is closed a signed
//                manifest plus an inclusion proof in the spent sum-MMR
//   issued side  GET /v1/solvent/issuance/<B_>  each replacement output's
//                signed receipt and inclusion in the same epoch's issued MMR
//
// Nothing is taken from an HTTP response on trust: signatures, inclusion
// proofs and sums are recomputed here, the manifest key must be the one the
// mint's NUT-06 identity delegated (already verified for the accepted
// issuance), and conservation is computed from the operation's rows.
import { Mint, OutputData, Wallet, type Proof } from '@cashu/cashu-ts';
import { invoicePaymentHash } from './bolt11.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { spentY } from '../cashu/reconstruct.js';
import { manifestDigestHex, verifyManifest, type ManifestFields } from '../pol/manifest.js';
import { hexToBytes, issuedLeaf, spentLeaf, verifyInclusionProof } from '../pol/mmr.js';
import { verifyIssuedReceipt, type PolReceipt } from '../pol/receipt.js';
import { inclusionProofFromJson } from './bundle-json.js';

/** 64 sats in, four proofs out: a real re-split, not a 1-for-1 exchange. */
export const SWAP_SPLIT = [32, 16, 8, 8];

export interface KeysetWithKeys {
  id: string;
  keys: Record<string, string>;
  inputFeePpk: number;
}

export interface SwapOutput {
  blindedMessage: string;
  amount: number;
  proof: Proof;
  y: string;
}

export interface SwapExecution {
  mintUrl: string;
  inputY: string;
  inputAmount: number;
  fee: number;
  outputs: SwapOutput[];
  swappedAt: string;
}

/** NUT-02: the fee for spending `inputs` proofs from a keyset with this input_fee_ppk. */
export function swapFee(inputs: number, inputFeePpk: number): number {
  return Math.floor((inputs * inputFeePpk + 999) / 1000);
}

/** Performs the real NUT-03 swap of one accepted proof. */
export async function executeSwap(mintUrl: string, proof: Proof, keyset: KeysetWithKeys): Promise<SwapExecution> {
  const inputAmount = Number(proof.amount);
  const fee = swapFee(1, keyset.inputFeePpk);
  const outAmount = inputAmount - fee;
  const split = fee === 0 && inputAmount === 64 ? SWAP_SPLIT : undefined;
  const data = OutputData.createRandomData(outAmount, { id: keyset.id, keys: keyset.keys }, split);
  const res = await new Mint(mintUrl).swap({ inputs: [proof], outputs: data.map((d) => d.blindedMessage) });
  if (res.signatures.length !== data.length) throw new Error(`the mint returned ${res.signatures.length} signatures for ${data.length} outputs`);
  const outputs = data.map((d, i) => {
    const p = d.toProof(res.signatures[i]!, { id: keyset.id, keys: keyset.keys });
    return { blindedMessage: d.blindedMessage.B_, amount: Number(p.amount), proof: p, y: spentY(p.secret) };
  });
  return { mintUrl, inputY: spentY(proof.secret), inputAmount, fee, outputs, swappedAt: new Date().toISOString() };
}

/** NUT-07: the mint's own answer for each Y, asked separately from the swap. */
export async function proofStates(mintUrl: string, ys: string[]): Promise<Record<string, string>> {
  const r = await new Mint(mintUrl).check({ Ys: ys });
  return Object.fromEntries(r.states.map((s) => [s.Y, String(s.state)]));
}

interface JsonManifestEnvelope {
  manifest: ManifestFields;
  manifestSignature: string;
}

export interface SpendResponse {
  state: 'EPOCH_OPEN' | 'EPOCH_CLOSED';
  proof_y: string;
  keyset_id: string;
  amount: number;
  target_epoch: number;
  operation: {
    kind: string;
    consumed: { proof_y: string; amount: number; target_epoch: number }[];
    issued: { blinded_message: string; amount: number; target_epoch: number }[];
    consumed_sum: number;
    issued_sum: number;
  };
  publication_status?: string;
  nostr_event_id?: string | null;
  evidence?: {
    manifest: ManifestFields;
    manifestSignature: string;
    masterPublicKeyHex: string;
    spentMmrSize: number;
    inclusionProof: Parameters<typeof inclusionProofFromJson>[0];
    leafIndex: number | null;
    previous: ({ epochIndex: number } & JsonManifestEnvelope) | null;
  };
}

export interface OutputIssuance {
  state: 'EPOCH_OPEN' | 'EPOCH_CLOSED';
  evidence?: {
    receipt: PolReceipt;
    manifest: ManifestFields;
    manifestSignature: string;
    masterPublicKeyHex: string;
    issuedMmrSize: number;
    inclusionProof: Parameters<typeof inclusionProofFromJson>[0];
  };
}

export interface Check {
  label: string;
  ok: boolean;
  detail: string;
}

export interface SwapAccounting {
  checks: Check[];
  ok: boolean;
  epoch: number;
  manifestDigest: string | null;
  liabilityBefore: number | null;
  liabilityAfter: number | null;
  /** issued - consumed for THIS operation, from its rows (0 for a fee-free swap). */
  operationNetLiability: number;
}

/**
 * Checks the mint's accounting of one swap. `manifestPubkey` must be the key
 * the mint's NUT-06 identity delegated (verified for the accepted issuance).
 */
export function checkSwapAccounting(
  exec: SwapExecution,
  spend: SpendResponse,
  issuances: Record<string, OutputIssuance>,
  manifestPubkey: string,
  amountPublicKeys: Record<string, string>,
): SwapAccounting {
  const checks: Check[] = [];
  const add = (label: string, ok: boolean, detail: string) => checks.push({ label, ok, detail });
  const op = spend.operation;

  add('Spent row is this proof', spend.proof_y === exec.inputY && spend.amount === exec.inputAmount, `Y ${spend.proof_y.slice(0, 16)}…, ${spend.amount} sats, operation ${op.kind}`);
  const consumedYs = op.consumed.map((c) => c.proof_y);
  add('Operation consumed exactly this input', consumedYs.length === 1 && consumedYs[0] === exec.inputY && op.consumed_sum === exec.inputAmount, `${consumedYs.length} input(s), ${op.consumed_sum} sats`);
  const ours = exec.outputs.map((o) => `${o.blindedMessage}:${o.amount}`).sort();
  const theirs = op.issued.map((i) => `${i.blinded_message}:${i.amount}`).sort();
  add(
    'Operation issued exactly these replacement outputs',
    ours.length === theirs.length && ours.every((x, i) => x === theirs[i]),
    `${theirs.length} output(s) recorded, ${ours.length} built by this browser; ${op.issued_sum} sats`,
  );
  const net = op.issued_sum - op.consumed_sum;
  add('Value conserved by the operation (issued − consumed = −fee)', net === -exec.fee, `${op.issued_sum} − ${op.consumed_sum} = ${net} (fee ${exec.fee})`);

  let manifestDigest: string | null = null;
  let liabilityBefore: number | null = null;
  let liabilityAfter: number | null = null;
  const ev = spend.evidence;
  const closed = spend.state === 'EPOCH_CLOSED' && !!ev;
  add('The epoch holding the spend is closed', closed, closed ? `epoch ${spend.target_epoch}` : `epoch ${spend.target_epoch} still open`);
  if (closed && ev) {
    manifestDigest = manifestDigestHex(ev.manifest);
    add('Manifest key is the one the NUT-06 identity delegated', ev.masterPublicKeyHex === manifestPubkey, ev.masterPublicKeyHex.slice(0, 16) + '…');
    add('Epoch manifest signature', verifyManifest(ev.manifest, ev.manifestSignature, manifestPubkey), `digest ${manifestDigest.slice(0, 16)}…`);
    const proof = inclusionProofFromJson(ev.inclusionProof);
    const inSpent =
      !!proof &&
      verifyInclusionProof(spentLeaf(exec.inputY, exec.inputAmount), proof, ev.spentMmrSize, hexToBytes(ev.manifest.spent_mmr_root_hash), BigInt(ev.manifest.spent_mmr_root_sum));
    add('Old proof is in the signed spent sum-MMR', inSpent, `leaf ${ev.leafIndex ?? '—'} of ${ev.spentMmrSize}`);
    add(
      'Manifest arithmetic: outstanding = issued − spent',
      ev.manifest.outstanding_balance === ev.manifest.issued_mmr_root_sum - ev.manifest.spent_mmr_root_sum,
      `${ev.manifest.issued_mmr_root_sum} − ${ev.manifest.spent_mmr_root_sum} = ${ev.manifest.outstanding_balance}`,
    );
    liabilityAfter = ev.manifest.outstanding_balance;
    if (ev.previous) {
      const prevOk = verifyManifest(ev.previous.manifest, ev.previous.manifestSignature, manifestPubkey);
      add('Previous epoch manifest signature (liability before)', prevOk, `epoch ${ev.previous.epochIndex}: ${ev.previous.manifest.outstanding_balance} sats outstanding`);
      if (prevOk) liabilityBefore = ev.previous.manifest.outstanding_balance;
    }
    for (const o of exec.outputs) {
      const iss = issuances[o.blindedMessage];
      const e = iss?.evidence;
      const pk = amountPublicKeys[String(o.amount)];
      const receiptOk = !!e && !!pk && verifyIssuedReceipt(e.receipt, o.blindedMessage, pk) && e.receipt.target_epoch === spend.target_epoch;
      const ip = e ? inclusionProofFromJson(e.inclusionProof) : null;
      const included =
        !!e &&
        !!ip &&
        manifestDigestHex(e.manifest) === manifestDigest &&
        verifyInclusionProof(issuedLeaf(o.blindedMessage, o.amount), ip, e.issuedMmrSize, hexToBytes(e.manifest.issued_mmr_root_hash), BigInt(e.manifest.issued_mmr_root_sum));
      add(`Replacement ${o.amount}-sat output: signed receipt + in the same epoch's issued sum-MMR`, iss?.state === 'EPOCH_CLOSED' && receiptOk && included, `B_ ${o.blindedMessage.slice(0, 16)}…`);
    }
  }
  return { checks, ok: checks.every((c) => c.ok), epoch: spend.target_epoch, manifestDigest, liabilityBefore, liabilityAfter, operationNetLiability: net };
}

// -------------------- NUT-05: pay a real invoice with accepted ecash --------------------

export interface MeltExecution {
  mintUrl: string;
  invoice: string;
  invoiceAmount: number;
  feeReserve: number;
  paymentPreimage: string | null;
  inputs: { y: string; amount: number }[];
  change: { y: string; amount: number; proof: Proof }[];
  meltedAt: string;
}

/** Performs a real NUT-05 melt: quote, then pay with these proofs; change comes back through NUT-08 blank outputs. */
/** How long the page follows a melt whose Lightning payment is still in flight. */
export const MELT_SETTLE_TIMEOUT_MS = 600_000;

type MeltQuoteState = { amount: unknown; fee_reserve: unknown; payment_preimage?: string | null; state?: string; change?: unknown[] };

/**
 * Melts proofs to pay a bolt11 invoice. A real Lightning payment can outlast
 * the mint's own wait: it then answers with an error or a PENDING quote while
 * the payment is still in flight. In that case the quote is followed until it
 * settles (NUT-05), and the change is recovered from the blank outputs this
 * wallet prepared (NUT-08). An UNPAID quote means the payment failed and the
 * inputs were released: the original error stands.
 */
export async function executeMelt(
  mintUrl: string,
  proofs: Proof[],
  invoice: string,
  onPending?: (elapsedSeconds: number) => void,
  settleTimeoutMs = MELT_SETTLE_TIMEOUT_MS,
): Promise<MeltExecution> {
  const wallet = new Wallet(mintUrl);
  await wallet.loadMint();
  const quote = await wallet.createMeltQuoteBolt11(invoice);
  const preview = await wallet.prepareMelt('bolt11', quote, proofs);
  let q: MeltQuoteState | null = null;
  let change: Proof[] = [];
  let failure: unknown = null;
  try {
    const res = await wallet.completeMelt(preview);
    q = res.quote as unknown as MeltQuoteState;
    change = res.change;
  } catch (err) {
    failure = err;
  }
  if (!q || q.state !== 'PAID') {
    const started = Date.now();
    for (;;) {
      const now = (await wallet.checkMeltQuoteBolt11(quote.quote)) as unknown as MeltQuoteState;
      if (now.state === 'PAID') {
        q = now;
        change = wallet.createMeltChangeProofs(preview.outputData, (now.change ?? []) as Parameters<typeof wallet.createMeltChangeProofs>[1]);
        break;
      }
      if (now.state === 'UNPAID' || Date.now() - started > settleTimeoutMs) {
        throw failure instanceof Error ? failure : new Error(`the melt did not settle (quote ${now.state ?? 'unknown'})`);
      }
      onPending?.(Math.round((Date.now() - started) / 1000));
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
  return {
    mintUrl,
    invoice,
    invoiceAmount: Number(q.amount),
    feeReserve: Number(q.fee_reserve),
    paymentPreimage: q.payment_preimage ?? null,
    inputs: proofs.map((p) => ({ y: spentY(p.secret), amount: Number(p.amount) })),
    change: change.map((p) => ({ y: spentY(p.secret), amount: Number(p.amount), proof: p })),
    meltedAt: new Date().toISOString(),
  };
}

export interface MeltAccounting extends SwapAccounting {
  feePaid: number;
}

/**
 * Checks one melt: the invoice was paid (the preimage hashes to its payment
 * hash), every input is in the signed spent sum-MMR, the change the wallet got
 * back is exactly the operation's issued rows (each with a signed receipt and
 * in the issued sum-MMR), and the operation reduced liability by exactly the
 * amount paid plus the routing fee, which stays within the quoted reserve.
 */
export function checkMeltAccounting(
  exec: MeltExecution,
  spends: SpendResponse[],
  issuances: Record<string, OutputIssuance>,
  manifestPubkey: string,
  amountPublicKeys: Record<string, string>,
): MeltAccounting {
  const checks: Check[] = [];
  const add = (label: string, ok: boolean, detail: string) => checks.push({ label, ok, detail });
  const hash = invoicePaymentHash(exec.invoice);
  const preimageOk = !!hash && !!exec.paymentPreimage && /^[0-9a-f]{64}$/.test(exec.paymentPreimage) && bytesToHex(sha256(hexToBytes(exec.paymentPreimage))) === hash;
  add('Invoice paid: the returned preimage hashes to the invoice\u2019s payment hash', preimageOk, `payment hash ${hash?.slice(0, 16) ?? '—'}…`);

  const first = spends[0];
  const op = first?.operation;
  const inputSum = exec.inputs.reduce((a, i) => a + i.amount, 0);
  const consumedYs = new Set((op?.consumed ?? []).map((c) => c.proof_y));
  add(
    'Operation consumed exactly these inputs',
    !!op && op.kind === 'melt' && consumedYs.size === exec.inputs.length && exec.inputs.every((i) => consumedYs.has(i.y)) && op.consumed_sum === inputSum,
    `${consumedYs.size} input(s), ${op?.consumed_sum ?? 0} sats, operation ${op?.kind ?? '—'}`,
  );
  const changeAmounts = exec.change.map((c) => c.amount).sort((a, b) => a - b).join(',');
  const issuedAmounts = (op?.issued ?? []).map((i) => i.amount).sort((a, b) => a - b).join(',');
  add('Change received is exactly the operation\u2019s issued rows', changeAmounts === issuedAmounts, `change [${changeAmounts}] vs issued [${issuedAmounts}]`);
  const feePaid = (op?.consumed_sum ?? 0) - exec.invoiceAmount - (op?.issued_sum ?? 0);
  add('Value conserved: consumed = paid + fee + change, fee within the quoted reserve', feePaid >= 0 && feePaid <= exec.feeReserve, `${op?.consumed_sum ?? 0} = ${exec.invoiceAmount} + ${feePaid} + ${op?.issued_sum ?? 0} (reserve ${exec.feeReserve})`);

  let manifestDigest: string | null = null;
  let liabilityBefore: number | null = null;
  let liabilityAfter: number | null = null;
  for (const sp of spends) {
    const ev = sp.evidence;
    const closed = sp.state === 'EPOCH_CLOSED' && !!ev;
    const input = exec.inputs.find((i) => i.y === sp.proof_y);
    const ip = ev ? inclusionProofFromJson(ev.inclusionProof) : null;
    const ok =
      closed && !!ev && !!input && !!ip &&
      ev.masterPublicKeyHex === manifestPubkey &&
      verifyManifest(ev.manifest, ev.manifestSignature, manifestPubkey) &&
      verifyInclusionProof(spentLeaf(sp.proof_y, input.amount), ip, ev.spentMmrSize, hexToBytes(ev.manifest.spent_mmr_root_hash), BigInt(ev.manifest.spent_mmr_root_sum));
    add(`Spent ${input?.amount ?? '?'}-sat input is in the signed spent sum-MMR (delegated manifest key)`, ok, `Y ${sp.proof_y.slice(0, 16)}…, epoch ${sp.target_epoch}`);
    if (ev && !manifestDigest) {
      manifestDigest = manifestDigestHex(ev.manifest);
      liabilityAfter = ev.manifest.outstanding_balance;
      if (ev.previous && verifyManifest(ev.previous.manifest, ev.previous.manifestSignature, manifestPubkey)) liabilityBefore = ev.previous.manifest.outstanding_balance;
      add('Manifest arithmetic: outstanding = issued − spent', ev.manifest.outstanding_balance === ev.manifest.issued_mmr_root_sum - ev.manifest.spent_mmr_root_sum, `${ev.manifest.issued_mmr_root_sum} − ${ev.manifest.spent_mmr_root_sum} = ${ev.manifest.outstanding_balance}`);
    }
  }
  for (const row of op?.issued ?? []) {
    const e = issuances[row.blinded_message]?.evidence;
    const pk = amountPublicKeys[String(row.amount)];
    const ip = e ? inclusionProofFromJson(e.inclusionProof) : null;
    const ok =
      !!e && !!pk && !!ip &&
      verifyIssuedReceipt(e.receipt, row.blinded_message, pk) &&
      verifyManifest(e.manifest, e.manifestSignature, manifestPubkey) &&
      verifyInclusionProof(issuedLeaf(row.blinded_message, row.amount), ip, e.issuedMmrSize, hexToBytes(e.manifest.issued_mmr_root_hash), BigInt(e.manifest.issued_mmr_root_sum));
    add(`Change ${row.amount}-sat output: signed receipt + in the issued sum-MMR`, ok, `B_ ${row.blinded_message.slice(0, 16)}…`);
  }
  const net = (op?.issued_sum ?? 0) - (op?.consumed_sum ?? 0);
  return { checks, ok: checks.every((c) => c.ok), epoch: first?.target_epoch ?? 0, manifestDigest, liabilityBefore, liabilityAfter, operationNetLiability: net, feePaid };
}
