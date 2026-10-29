/**
 * Audit a002: a token-trader exit must not depend on the buy-time safety gate. A coin whose sell tax rose past the
 * live cap is exactly the one the "sell tax rose" exit wants out of; the buy gate would block that sell forever.
 * Buys still need the gate.
 */
import { describe, expect, it } from 'vitest';
import { createTokenTrader } from '../src/server/market/tokenFeed';
import { MemoryStore } from '../src/server/bot/store';
import { DEFAULT_LIMITS } from '../src/live/limits';

const TAX = 'Tax above the 10% live cap (sell 20.00%) — paper only.';

function trader() {
  const hub = {
    runtimes: () => [],
    inspect: async () => ({ draft: { key: 'x' }, safety: { liveAllowed: false, risk: 'blocked', reasons: [TAX] } }),
    draftQuoter: () => ({}),
    rt: () => ({ signer: null, gate: { run: <T>(f: () => Promise<T>) => f() }, nonce: {} }),
  };
  const t = createTokenTrader({ hub: hub as never, gecko: {} as never, store: new MemoryStore(), emit: () => undefined, approval: 'exact', receiptTimeoutMs: 1000 });
  return (t as unknown as { d: { live: { buy: (...a: unknown[]) => Promise<unknown>; sell: (...a: unknown[]) => Promise<unknown> } } }).d.live;
}

const pos = { chainId: 369, pool: '0xpool', dex: 'pulsex-v2', token: '0xtoken', spend: '0xspend', label: 'XYZ/PLS', source: 'new', liq: 1, volume: 1, quoteReserve: 1, tokenReserve: 1, feeBps: 30, price: 1, usdPerSpend: 1 };

describe('token trader: exits do not go through the buy-time safety gate', () => {
  it('a sell of a coin the gate now blocks reaches the swap (here: no signing key), not the tax refusal', async () => {
    await expect(trader().sell(pos, 100, DEFAULT_LIMITS)).rejects.toThrow('no signing key');
  });
  it('a buy of that coin is still refused by the gate', async () => {
    await expect(trader().buy({ ...pos, kind: 'v2' }, 1, DEFAULT_LIMITS)).rejects.toThrow(TAX);
  });
});
