// SOLVENT solvency-report Nostr event: schema, signing, and local
// signature/shape verification. Publishing to relays lives in publish.ts.
//
// Kind: 31111 (parameterized-replaceable, per NIP-01 kind range
// 30000–39999). The `d` tag is the mint identity, so a relay/client keeps
// only the latest report per mint. Documented in docs/event-schema.md.
import { finalizeEvent, getPublicKey, verifyEvent, type EventTemplate, type NostrEvent } from 'nostr-tools';

export const SOLVENT_EVENT_KIND = 31111;
export const SOLVENT_SCHEMA = 'solvent/v1';

export interface SolvencyEventContent {
  schema: 'solvent/v1';
  mint_pubkey: string;
  keyset_id: string;
  epoch: number;
  mint_root: { hash: string; sum_sats: number };
  burn_root: { hash: string; sum_sats: number };
  liabilities_sats: number;
  reserve_sats: number;
  reserve_kind: 'demo-reserve';
  ratio: number;
  issued_at: number;
  valid_until: number;
  proof_uri: string;
  notes: string;
}

export function buildEventContent(params: {
  mintPubkeyHex: string;
  keysetId: string;
  epoch: number;
  mintRoot: { hashHex: string; sumSats: number };
  burnRoot: { hashHex: string; sumSats: number };
  liabilitiesSats: number;
  reserveSats: number;
  validitySeconds: number;
  proofUri: string;
  notes: string;
  now?: number;
}): SolvencyEventContent {
  const issuedAt = params.now ?? Math.floor(Date.now() / 1000);
  return {
    schema: SOLVENT_SCHEMA,
    mint_pubkey: params.mintPubkeyHex,
    keyset_id: params.keysetId,
    epoch: params.epoch,
    mint_root: { hash: params.mintRoot.hashHex, sum_sats: params.mintRoot.sumSats },
    burn_root: { hash: params.burnRoot.hashHex, sum_sats: params.burnRoot.sumSats },
    liabilities_sats: params.liabilitiesSats,
    reserve_sats: params.reserveSats,
    reserve_kind: 'demo-reserve',
    ratio: params.liabilitiesSats > 0 ? params.reserveSats / params.liabilitiesSats : Infinity,
    issued_at: issuedAt,
    valid_until: issuedAt + params.validitySeconds,
    proof_uri: params.proofUri,
    notes: params.notes,
  };
}

export function signSolvencyEvent(content: SolvencyEventContent, mintIdentity: string, secretKey: Uint8Array): NostrEvent {
  const template: EventTemplate = {
    kind: SOLVENT_EVENT_KIND,
    created_at: content.issued_at,
    tags: [
      ['d', mintIdentity],
      ['keyset', content.keyset_id],
      ['epoch', String(content.epoch)],
    ],
    content: JSON.stringify(content),
  };
  return finalizeEvent(template, secretKey);
}

export interface EventVerificationResult {
  signatureValid: boolean;
  contentParses: boolean;
  content?: SolvencyEventContent;
  reason?: string;
}

/** Local, offline checks only: signature validity and content schema shape. Freshness/latest-event/identity checks live in verifier/rules.ts. */
export function verifySolvencyEvent(event: NostrEvent): EventVerificationResult {
  // nostr-tools' verifyEvent memoizes its result on a symbol property of the
  // exact object passed in. Round-tripping through JSON (which is how every
  // real event arrives, from a relay) strips any such property, so a stale
  // cached "true" from an earlier, different object can never leak in here.
  const freshEvent = JSON.parse(JSON.stringify(event)) as NostrEvent;
  let signatureValid: boolean;
  try {
    signatureValid = verifyEvent(freshEvent);
  } catch {
    signatureValid = false;
  }
  if (!signatureValid) {
    return { signatureValid: false, contentParses: false, reason: 'invalid Nostr event signature' };
  }
  if (event.kind !== SOLVENT_EVENT_KIND) {
    return { signatureValid, contentParses: false, reason: `unexpected event kind ${event.kind}, expected ${SOLVENT_EVENT_KIND}` };
  }
  try {
    const parsed = JSON.parse(event.content) as Partial<SolvencyEventContent>;
    if (parsed.schema !== SOLVENT_SCHEMA) {
      return { signatureValid, contentParses: false, reason: `unexpected schema "${parsed.schema}"` };
    }
    if (
      typeof parsed.mint_pubkey !== 'string' ||
      typeof parsed.keyset_id !== 'string' ||
      typeof parsed.epoch !== 'number' ||
      !parsed.mint_root ||
      typeof parsed.mint_root.hash !== 'string' ||
      typeof parsed.mint_root.sum_sats !== 'number' ||
      !parsed.burn_root ||
      typeof parsed.burn_root.hash !== 'string' ||
      typeof parsed.burn_root.sum_sats !== 'number' ||
      typeof parsed.liabilities_sats !== 'number' ||
      typeof parsed.reserve_sats !== 'number' ||
      parsed.reserve_kind !== 'demo-reserve' ||
      typeof parsed.issued_at !== 'number' ||
      typeof parsed.valid_until !== 'number'
    ) {
      return { signatureValid, contentParses: false, reason: 'event content missing required solvent/v1 fields' };
    }
    return { signatureValid, contentParses: true, content: parsed as SolvencyEventContent };
  } catch (err) {
    return { signatureValid, contentParses: false, reason: `event content is not valid JSON: ${(err as Error).message}` };
  }
}

export function deriveNostrPubkey(secretKey: Uint8Array): string {
  return getPublicKey(secretKey);
}

export function isEventFresh(content: Pick<SolvencyEventContent, 'issued_at' | 'valid_until'>, nowSeconds: number): boolean {
  return nowSeconds >= content.issued_at && nowSeconds <= content.valid_until;
}
