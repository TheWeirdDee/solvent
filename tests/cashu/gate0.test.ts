// Automated regression coverage for Gate 0 (see docs/gate-0.md). Runs the
// exact same real-library spike as `npx tsx src/cli/gate0.ts`, minus the
// evidence-file writing, so a future dependency bump that silently changes
// transfer/DLEQ behavior fails CI instead of being rediscovered by hand.
import { describe, expect, it } from 'vitest';
import { runGate0Spike } from '../../src/cashu/gate0.js';

describe('Gate 0 — NUT-12 transfer invariant', () => {
  it('a real token, pushed through getEncodedToken/getDecodedToken, still carries usable dleq.e/s/r', () => {
    const r = runGate0Spike();
    expect(r.dleqSurvivedTransfer).toBe(true);
  });

  it('receiver reconstructs the exact original B\' from received-proof data alone', () => {
    const r = runGate0Spike();
    expect(r.reconstructedBPrimeHex).toBe(r.originalBPrimeHex);
    expect(r.bPrimeEqual).toBe(true);
  });

  it('receiver reconstructs the exact original C\' (mint\'s real blind signature)', () => {
    const r = runGate0Spike();
    expect(r.reconstructedCPrimeHex).toBe(r.originalCPrimeHex);
    expect(r.cPrimeEqual).toBe(true);
  });

  it('DLEQ verifies against the correct amount key', () => {
    const r = runGate0Spike();
    expect(r.dleqValid).toBe(true);
  });

  it('overall gate passes', () => {
    const r = runGate0Spike();
    expect(r.pass).toBe(true);
  });
});
