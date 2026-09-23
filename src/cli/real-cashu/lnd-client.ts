// A minimal, real LND REST v1 client — no mocking, no simulated responses.
// Used by real-cashu-foundation.ts to independently drive and observe real
// regtest Lightning payments, separately from whatever the CDK mint itself
// reports. Every call here is a real HTTP request to a real running `lnd`
// process (see docs/real-cashu-stack.md for how that process gets started).
//
// TLS: regtest LND nodes started by this phase's tooling use LND's own
// self-signed tls.cert. Verifying it would mean parsing/trusting a
// throwaway regtest cert chain for no real security benefit (there is
// nothing of value on the other end), so this client disables TLS
// verification via NODE_TLS_REJECT_UNAUTHORIZED — REGTEST-ONLY, never an
// appropriate pattern for a real deployment. See real-cashu-foundation.ts's
// module header.

export interface LndClientOptions {
  restUrl: string; // e.g. https://127.0.0.1:8081
  macaroonHex: string;
}

export interface LndInfo {
  identity_pubkey: string;
  synced_to_chain: boolean;
  block_height: number;
  alias: string;
}

export interface LndInvoice {
  r_hash: string; // hex
  payment_request: string; // bolt11
  add_index: string;
}

export interface LndInvoiceLookup {
  settled: boolean;
  state: 'OPEN' | 'SETTLED' | 'CANCELED' | 'ACCEPTED';
  amt_paid_sat?: string;
}

export interface LndPaymentResult {
  ok: boolean;
  paymentError?: string;
  paymentPreimageHex?: string;
  paymentHashHex?: string;
}

export class LndClient {
  constructor(private opts: LndClientOptions) {}

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.opts.restUrl}${path}`, {
      method,
      headers: {
        'Grpc-Metadata-macaroon': this.opts.macaroonHex,
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`LND REST ${method} ${path} -> HTTP ${res.status}: ${text}`);
    return JSON.parse(text) as T;
  }

  async getInfo(): Promise<LndInfo> {
    return this.call<LndInfo>('GET', '/v1/getinfo');
  }

  /** Real invoice, created on THIS node — independent of anything a mint claims to have generated. */
  async createInvoice(valueSat: number, memo: string): Promise<LndInvoice> {
    const raw = await this.call<{ r_hash: string; payment_request: string; add_index: string }>('POST', '/v1/invoices', {
      value: String(valueSat),
      memo,
    });
    return { r_hash: base64ToHex(raw.r_hash), payment_request: raw.payment_request, add_index: raw.add_index };
  }

  /** Looks up an invoice by its real hex payment hash — the independent "did this Lightning node actually see this settle" check. */
  async lookupInvoice(paymentHashHex: string): Promise<LndInvoiceLookup> {
    const hashUrlSafe = hexToBase64Url(paymentHashHex);
    return this.call<LndInvoiceLookup>('GET', `/v2/invoices/lookup?payment_hash=${hashUrlSafe}`);
  }

  /**
   * Pays a real bolt11 invoice from THIS node's real channel balance — a
   * real Lightning payment, not a mocked settlement.
   *
   * Uses `POST /v2/router/send` (`Router.SendPaymentV2`) — the old
   * `POST /v1/channels/transactions` (`SendPaymentSync`) REST mapping no
   * longer exists on the mainline `Lightning` service as of this pinned
   * LND release (confirmed by inspecting `lnrpc/lightning.swagger.json`
   * at the pinned tag after a real HTTP 404 on the old path — not
   * assumed). `SendPaymentV2` is a *streaming* RPC even over REST: the
   * response body is newline-delimited JSON, each line either
   * `{"result": {...Payment}}` or `{"error": {...}}`, ending once the
   * payment reaches a terminal state. Also sets an explicit
   * `fee_limit_sat` — LND's own docs warn the default fee limit is zero,
   * which "often fails with FAILURE_REASON_NO_ROUTE" even for routes that
   * would otherwise succeed.
   */
  async payInvoiceSync(paymentRequest: string, feeLimitSat = 1000): Promise<LndPaymentResult> {
    const res = await fetch(`${this.opts.restUrl}/v2/router/send`, {
      method: 'POST',
      headers: { 'Grpc-Metadata-macaroon': this.opts.macaroonHex, 'content-type': 'application/json' },
      body: JSON.stringify({ payment_request: paymentRequest, fee_limit_sat: String(feeLimitSat), timeout_seconds: 60 }),
    });
    if (!res.ok || !res.body) {
      const text = await res.text().catch(() => '');
      return { ok: false, paymentError: `HTTP ${res.status}: ${text}` };
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newlineIndex: number;
      while ((newlineIndex = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newlineIndex).trim();
        buffer = buffer.slice(newlineIndex + 1);
        if (!line) continue;
        const parsed = JSON.parse(line) as { result?: { status?: string; payment_preimage?: string; payment_hash?: string; failure_reason?: string }; error?: { message?: string } };
        if (parsed.error) return { ok: false, paymentError: parsed.error.message ?? JSON.stringify(parsed.error) };
        const status = parsed.result?.status;
        if (status === 'SUCCEEDED') {
          return {
            ok: true,
            paymentPreimageHex: parsed.result?.payment_preimage,
            paymentHashHex: parsed.result?.payment_hash,
          };
        }
        if (status === 'FAILED') {
          return { ok: false, paymentError: parsed.result?.failure_reason ?? 'payment failed' };
        }
        // IN_FLIGHT / INITIATED — keep reading the stream for the terminal update.
      }
    }
    return { ok: false, paymentError: 'payment stream ended without a terminal status' };
  }

  /** Lists this node's own real, observed payment history — used to independently confirm a payment actually settled, never trusting the mint's own claim alone. */
  async listPayments(): Promise<{ payments: { payment_hash: string; status: string; payment_request?: string }[] }> {
    return this.call('GET', '/v1/payments?include_incomplete=true');
  }

  async connectPeer(pubkey: string, host: string): Promise<void> {
    try {
      await this.call('POST', '/v1/peers', { addr: { pubkey, host }, perm: false });
    } catch (err) {
      // Already-connected is a benign, expected outcome when re-running setup.
      if (!/already connected/i.test((err as Error).message)) throw err;
    }
  }

  async openChannelSync(nodePubkeyHex: string, localFundingAmountSat: number): Promise<{ funding_txid_str: string }> {
    return this.call('POST', '/v1/channels', {
      node_pubkey: hexToBase64(nodePubkeyHex),
      local_funding_amount: String(localFundingAmountSat),
    });
  }

  async listChannels(): Promise<{ channels: { active: boolean; remote_pubkey: string; capacity: string }[] }> {
    return this.call('GET', '/v1/channels');
  }

  async newAddress(): Promise<{ address: string }> {
    return this.call('GET', '/v1/newaddress?type=WITNESS_PUBKEY_HASH');
  }
}

function base64ToHex(b64: string): string {
  return Buffer.from(b64, 'base64').toString('hex');
}
function hexToBase64(hex: string): string {
  return Buffer.from(hex, 'hex').toString('base64');
}
function hexToBase64Url(hex: string): string {
  return Buffer.from(hex, 'hex').toString('base64url');
}
