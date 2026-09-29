// npm run verify:phase3b-evidence -- <evidence-dir>
//
// Deterministic, offline re-verification of a `npm run phase3b:live` run.
// No network: every decision is replayed through the SAME central path
// (verifySubmission -> verify) with exactly the observations the live run
// recorded (NUT-06 identity, chain state, relay responses, clock), and the
// cryptography is recomputed independently from the artifacts themselves.
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { getEventHash, verifyEvent, type NostrEvent } from 'nostr-tools';
import { submissionBundleFromJson } from '../../app/bundle-json.js';
import { computeGlobalDigestHex, verifySubmission, type SubmissionBundle } from '../../app/submission.js';
import { delegationDigestHex, verifyDelegatedManifest, verifyManifestKeyDelegation } from '../../epoch/delegation.js';
import type { PolEvidenceContent } from '../../nostr/pol-event.js';
import { manifestDigestHex } from '../../pol/manifest.js';
import { reserveBindingDigestHex, verifyReserveBinding } from '../../reserve/binding.js';
import { RESERVE_NETWORK_LABEL } from '../../reserve/esplora.js';
import type { ChainStateEntry } from '../../reserve/evaluate.js';
import { reserveStatementDigestHex, verifyReserveStatementSignature } from '../../reserve/statement.js';

let failures = 0;
function check(label: string, ok: boolean, detail?: string): boolean {
  console.log(`${label.padEnd(78)}${ok ? 'PASS' : 'FAIL'}${detail ? '  ' + detail : ''}`);
  if (!ok) failures++;
  return ok;
}

interface Observed {
  nut06?: { ok: true; pubkey: string } | { ok: false; detail: string };
  chain?: { ok: boolean; tipHeight: number; chainState: [string, ChainStateEntry][]; detail: string };
  relayQueries: { relayReachable: boolean; events: NostrEvent[] }[];
  now?: number;
}

/** Replays one recorded decision through verifySubmission with the recorded observations only. */
async function replay(bundle: SubmissionBundle, observed: Observed) {
  let q = 0;
  return verifySubmission(
    bundle,
    async () => {
      const r = observed.relayQueries[Math.min(q++, observed.relayQueries.length - 1)] ?? { relayReachable: false, events: [] };
      return { events: r.events, queriedRelays: [], relayReachable: r.relayReachable };
    },
    async () =>
      observed.chain
        ? { ok: observed.chain.ok, tipHeight: observed.chain.tipHeight, chainState: new Map(observed.chain.chainState), detail: 'recorded' }
        : { ok: false, tipHeight: 0, chainState: new Map(), detail: 'no chain observation recorded' },
    async () => {},
    { mintInfoFetchFn: async () => observed.nut06 ?? { ok: false, detail: 'no NUT-06 observation recorded' }, nowSeconds: () => observed.now ?? 0 },
  );
}

async function main() {
  const dir = process.argv[2];
  if (!dir) throw new Error('usage: verify-phase3b-evidence.ts <evidence-dir>');
  const read = (f: string) => JSON.parse(readFileSync(path.join(dir, f), 'utf8'));
  const bundleOf = (f: string) => submissionBundleFromJson(readFileSync(path.join(dir, f), 'utf8'));

  console.log(`SOLVENT — PHASE 3B EVIDENCE VERIFICATION (offline replay)\n${dir}\n`);
  const summary = read('phase3-delegation.json');
  console.log(`Lightning backend recorded: ${summary.lightning_backend}\n`);

  // --- delegation --------------------------------------------------------
  const d = summary.delegation;
  const nut06 = summary.nut06_observed;
  check('Delegation verifies under the recorded NUT-06 identity', nut06.ok && verifyManifestKeyDelegation(d, { mintUrl: d.mint_url, mintIdentityPubkey: nut06.pubkey, manifestPubkey: d.manifest_pubkey, epochIndex: d.valid_from_epoch }).ok, nut06.pubkey);

  // --- honest / omission ---------------------------------------------------
  for (const [label, input, result, expected, fetchback, manifestFile] of [
    ['HONEST', 'phase3-honest-verify-input.json', 'phase3-accept.json', 'ACCEPT_VERIFIED', 'phase3-nostr-fetchback.json', 'phase3-manifest.json'],
    ['BROKEN PROMISE', 'phase3-omission-verify-input.json', 'phase3-omission-refuse.json', 'REFUSE_ISSUANCE_OMITTED', 'phase3-omission-nostr-fetchback.json', 'phase3-omission-manifest.json'],
  ] as const) {
    console.log(`\n— ${label} —`);
    const b = bundleOf(input);
    const rec = read(result);
    const fb = read(fetchback);
    const m = read(manifestFile);
    const identity = rec.observed.nut06?.pubkey as string;

    check(`${label}: delegation -> manifest key -> manifest signature`, verifyDelegatedManifest(b.manifest, b.manifestSignature, b.masterPublicKeyHex, b.delegation!, { mintUrl: b.mint, mintIdentityPubkey: identity }).ok);
    const global = computeGlobalDigestHex(b.manifest);
    check(`${label}: global digest recomputes from the manifest (single keyset)`, global === m.global_digest && b.epochKeysetCount === 1, global.slice(0, 16));
    check(`${label}: closed-epoch audit recorded OK (MMRs re-derived from rows)`, m.audit?.ok === true);

    const st = b.reserveAttestation!.statement;
    check(`${label}: reserve statement signed by the reserve-control key`, verifyReserveStatementSignature(st, b.reserveAttestation!.statementSignature), st.reserve_pubkey.slice(0, 16));
    check(
      `${label}: reserve binding signed by the delegated manifest key for this epoch`,
      verifyReserveBinding(b.reserveBinding!, {
        manifestPubkey: b.masterPublicKeyHex, mintUrl: b.mint, mintIdentityPubkey: identity, epochIndex: b.manifest.epoch_index,
        manifestDigest: manifestDigestHex(b.manifest), globalDigest: global, reserveStatementDigest: reserveStatementDigestHex(st),
        reservePubkey: st.reserve_pubkey, reserveNetwork: RESERVE_NETWORK_LABEL, nowSeconds: rec.observed.now,
      }).ok,
    );
    const chainValue = (rec.observed.chain.chainState as [string, ChainStateEntry][]).reduce((s, [, e]) => s + (e.exists && !e.spent ? e.value : 0), 0);
    check(`${label}: coverage recomputed from recorded chain state`, chainValue >= b.manifest.outstanding_balance, `${chainValue} >= ${b.manifest.outstanding_balance}`);

    const ev = fb.fetched_event as NostrEvent;
    const c = JSON.parse(ev.content) as PolEvidenceContent;
    check(`${label}: fetched Nostr event id recomputes and signature verifies`, getEventHash(ev) === ev.id && verifyEvent(JSON.parse(JSON.stringify(ev))) && ev.id === b.nostrEvent!.id, ev.id.slice(0, 16));
    check(
      `${label}: event content binds manifest, global, reserve, delegation and binding digests`,
      c.manifest_digest === manifestDigestHex(b.manifest) && c.global_digest === global && c.reserve_digest === reserveStatementDigestHex(st) &&
        c.manifest_key_delegation_digest === delegationDigestHex(b.delegation!) && c.reserve_binding_digest === reserveBindingDigestHex(b.reserveBinding!) &&
        c.mint_nut06_pubkey === identity,
    );
    check(`${label}: receipt promises the closed epoch`, b.receipt.target_epoch === b.manifest.epoch_index, `epoch ${b.receipt.target_epoch}`);
    check(`${label}: inclusion proof ${expected === 'ACCEPT_VERIFIED' ? 'present' : 'absent (omitted)'}`, (b.inclusionProof !== null) === (expected === 'ACCEPT_VERIFIED'));

    const r = await replay(b, rec.observed);
    check(`${label}: replayed central decision == ${expected} (recorded ${rec.reason_code})`, r.result.reasonCode === expected && rec.reason_code === expected, r.result.reasonCode);
  }

  // --- negative Nostr cases ------------------------------------------------
  console.log('\n— PUBLICATION FAILURE CASES —');
  const nf = read('phase3-nostr-not-found.json');
  const nfr = await replay(bundleOf('phase3-nostr-not-found-verify-input.json'), nf.observed);
  check('NOT FOUND: replayed decision == REFUSE_NOSTR_EVENT_NOT_FOUND', nfr.result.reasonCode === 'REFUSE_NOSTR_EVENT_NOT_FOUND' && nf.reason_code === 'REFUSE_NOSTR_EVENT_NOT_FOUND', nfr.result.reasonCode);
  const un = read('phase3-nostr-unavailable.json');
  const unr = await replay(bundleOf('phase3-honest-verify-input.json'), un.observed);
  check('UNAVAILABLE: replayed decision == REFUSE_NOSTR_UNAVAILABLE', unr.result.reasonCode === 'REFUSE_NOSTR_UNAVAILABLE' && un.reason_code === 'REFUSE_NOSTR_UNAVAILABLE', unr.result.reasonCode);

  // --- labels and spent proofs --------------------------------------------
  console.log('\n— LABELS AND HOLDER PROOFS —');
  const backend = summary.lightning_backend;
  const unlabelled = readdirSync(dir).filter((f) => {
    const j = JSON.parse(readFileSync(path.join(dir, f), 'utf8'));
    return (j.lightning_backend ?? j._evidence?.lightning_backend) !== backend;
  });
  check(`Every artifact is labelled lightning_backend=${backend}`, unlabelled.length === 0, unlabelled.join(', '));
  const spent = read('phase3-proofs-spent.json');
  check('Every holder proof included for replay was spent before the run ended', spent.pass === true && spent.proofs.length > 0 && spent.proofs.every((p: { state: string }) => p.state === 'SPENT'), `${spent.proofs.length} proofs`);

  // --- secret scan ---------------------------------------------------------
  console.log('\n— SECRET SCAN —');
  const markers = [/\bxprv[1-9A-HJ-NP-Za-km-z]{20,}/, /\bnsec1[0-9a-z]{20,}/, /abandon abandon/, /macaroon/i, /PrivateKeyHex|privkey"/i, /mnemonic/i];
  const hits: string[] = [];
  for (const f of readdirSync(dir)) {
    const text = readFileSync(path.join(dir, f), 'utf8');
    for (const re of markers) if (re.test(text)) hits.push(`${f}: ${re}`);
  }
  check('No secret markers in any artifact', hits.length === 0, hits.join('; '));

  console.log('');
  if (failures === 0) console.log('PHASE 3B EVIDENCE VERIFIED');
  else {
    console.log(`PHASE 3B EVIDENCE NOT VERIFIED — ${failures} check(s) failed`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error('verify-phase3b-evidence crashed:', err);
  process.exitCode = 1;
});
