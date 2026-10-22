import { describe, expect, it } from 'vitest';
import { Hub } from '../src/server/chains/hub';
import { Converter, PLAN_TTL_MS, type Allocation, type Plan } from '../src/server/convert/converter';
import { findRoute, namedLikeSite, type RouteMarket } from '../src/market/convertRoute';
import { NATIVE } from '../src/live/swapMath';
import { MockChain, NET, ME } from './helpers/mockChain';

const E18 = 10n ** 18n;
const WPLS = NET.pulsex.wpls.toLowerCase();
const addr = (sym: string) => NET.quotes.find((q) => q.symbol === sym)!.address.toLowerCase();
const DAI = addr('DAI'), HEX = addr('HEX'), USDC = addr('USDC');
const TKN = '0x00000000000000000000000000000000000000a1'; // held, no pool anywhere
const SCAM = '0x00000000000000000000000000000000000000b2'; // an airdrop named like a website

describe('findRoute: swaps from one coin to another over the markets', () => {
  const M: RouteMarket[] = [
    { key: 'DAI', base: NATIVE, quote: 'dai' }, { key: 'HEX', base: NATIVE, quote: 'hex' },
    { key: 'X', base: 'x', quote: 'dai' },
  ];
  it('one market joining them: sell its base, or spend its quote on its base', () => {
    expect(findRoute(NATIVE, 'dai', M)).toEqual([{ key: 'DAI', side: 'sell', from: NATIVE, to: 'dai' }]);
    expect(findRoute('dai', NATIVE, M)).toEqual([{ key: 'DAI', side: 'buy', from: 'dai', to: NATIVE }]);
  });
  it('two swaps through a coin both sides trade against, the native coin first', () => {
    expect(findRoute('hex', 'dai', M)).toEqual([{ key: 'HEX', side: 'buy', from: 'hex', to: NATIVE }, { key: 'DAI', side: 'sell', from: NATIVE, to: 'dai' }]);
    expect(findRoute('x', NATIVE, M)).toEqual([{ key: 'X', side: 'sell', from: 'x', to: 'dai' }, { key: 'DAI', side: 'buy', from: 'dai', to: NATIVE }]);
  });
  it('the same coin needs nothing; no route of two swaps is null', () => {
    expect(findRoute('dai', 'dai', M)).toEqual([]);
    expect(findRoute('x', 'hex', M)).toBeNull(); // x → dai → PLS → hex is three
    expect(findRoute('nope', 'dai', M)).toBeNull();
  });
});

describe('namedLikeSite: scam airdrops are never touched', () => {
  it('a name or symbol like a web address; ordinary coins pass', () => {
    expect(namedLikeSite('https://pcock.page.gd')).toBe(true);
    expect(namedLikeSite('X', 'Visit www.claim-pls.com')).toBe(true);
    expect(namedLikeSite('Reward', 'airdrop.xyz')).toBe(true);
    for (const n of ['Morbius', 'FLOWT', 'HEX', 'eHEX', 'PulseX', 'Wrapped Pulse', 'Dai Stablecoin from Ethereum']) expect(namedLikeSite(n), n).toBe(false);
  });
});

/** PulseChain mock: PLS ≈ 0.00001 DAI; the wallet holds PLS, DAI, HEX, WPLS, a coin with no pool and a scam airdrop. */
function setup(o: { allocations?: Allocation[]; price?: number; depth?: number; listed?: object[]; tknDecimals?: string } = {}) {
  const chain = new MockChain(o.price ?? 0.00001, { quoteDepth: o.depth });
  chain.pls = 10_000_000n * E18;
  chain.setBal('HEX', 5_000); // 0.5% of the mock pool: well under the impact cap
  chain.setBal('DAI', 20);
  chain.setBal('USDC', 0.000001);
  for (const s of ['USDT', 'eHEX', 'PLSX']) chain.setBal(s, 0);
  chain.balances.set(WPLS, 1_000_000n * E18);
  chain.balances.set(TKN, 5n * E18);
  chain.balances.set(SCAM, 15_555n * E18);
  const hub = Hub.single(NET, chain, chain);
  const explorer = {
    items: [
      { token: { address: TKN, symbol: 'TKN', name: 'Token', decimals: o.tknDecimals ?? '18', type: 'ERC-20' }, value: '5' },
      { token: { address: SCAM, symbol: 'https://pcock.page.gd', name: 'https://pcock.page.gd', decimals: '18', type: 'ERC-20' }, value: '1' },
      ...(o.listed ?? []),
    ],
    next_page_params: null,
  };
  const urls: string[] = [];
  const cv = new Converter({ hub, allocations: () => o.allocations ?? [], approval: 'exact', fetchJson: async (u) => { urls.push(u); return explorer; }, pollMs: 1 });
  return { chain, hub, cv, urls };
}
const row = (p: Plan, sym: string) => p.rows.find((r) => r.coin.symbol === sym)!;
async function finished(cv: Converter) {
  for (let i = 0; i < 400 && !cv.job()?.finishedAt; i++) await new Promise((r) => setTimeout(r, 5));
  return cv.job()!;
}

describe('Converter: the plan', () => {
  it('every coin with its amount, route and expected result, or why it is left alone', async () => {
    const { cv, urls } = setup();
    const p = await cv.plan({ chainId: 369, target: DAI });
    expect(urls[0]).toBe(`https://api.scan.pulsechain.com/api/v2/addresses/${ME}/tokens?type=ERC-20`);
    expect(p).toMatchObject({ owner: ME, target: { symbol: 'DAI' }, targetBalance: 20, keepNative: 100_000, maxImpact: 0.03, listedBy: 'explorer' });
    expect(p.rows.map((r) => r.coin.symbol)).toEqual(['PLS', 'WPLS', 'USDC', 'HEX', 'TKN', 'https://pcock.page.gd']);
    // PLS: all but what's kept for gas, straight to DAI
    expect(row(p, 'PLS')).toMatchObject({ balance: 10_000_000, keep: 100_000, amount: 9_900_000, ok: true, steps: ['PLS → DAI · PulseX V1'] });
    expect(row(p, 'PLS').out!).toBeCloseTo(9_900_000 * 0.00001, 0); // ≈ 99 DAI after the 0.29% fee
    // HEX goes through PLS; WPLS is unwrapped first
    expect(row(p, 'HEX')).toMatchObject({ ok: true, steps: ['HEX → PLS · PulseX V2', 'PLS → DAI · PulseX V1'] });
    expect(row(p, 'WPLS')).toMatchObject({ ok: true, steps: ['WPLS → PLS · unwrap', 'PLS → DAI · PulseX V1'] });
    // left alone: dust, no pool, a scam
    expect(row(p, 'USDC').why).toMatch(/less than twice the gas/);
    expect(row(p, 'TKN').why).toMatch(/No pool/);
    expect(row(p, 'https://pcock.page.gd')).toMatchObject({ ok: false, steps: [], why: expect.stringMatching(/website/) });
    expect(p.unreadable).toEqual([]);
  });

  it('coins live bots use stay with them; the rest is converted', async () => {
    const { cv } = setup({ allocations: [{ chainId: 369, address: WPLS, native: true, allocated: 4_000_000 }, { chainId: 369, address: HEX, native: false, allocated: 5_000 }] });
    const p = await cv.plan({ chainId: 369, target: DAI });
    expect(row(p, 'PLS')).toMatchObject({ bots: 4_000_000, amount: 5_900_000, ok: true });
    expect(row(p, 'HEX')).toMatchObject({ bots: 5_000, amount: 0, ok: false, why: 'Your live bots use all of it.' });
  });

  it('a swap over the price-impact cap is skipped with the impact it would have', async () => {
    const { cv } = setup({ depth: 5 }); // 5 DAI of depth: PLS → DAI moves the price a lot
    const p = await cv.plan({ chainId: 369, target: DAI, maxImpact: 0.03 });
    expect(row(p, 'PLS').ok).toBe(false);
    expect(row(p, 'PLS').why).toMatch(/Would move the price \d+\.\d+% \(your cap is 3\.0%\)/);
  });

  it('an explorer coin\'s decimals are read on-chain, not taken from the explorer', async () => {
    // the explorer says 6 decimals; decimals() on-chain says 18: 5 TKN, not 5,000,000,000,000
    const { cv } = setup({ tknDecimals: '6' });
    expect(row(await cv.plan({ chainId: 369, target: DAI }), 'TKN')).toMatchObject({ balance: 5, coin: { decimals: 18 } });
  });

  it('a listed coin the chain won\'t answer for is shown and left alone; the other coins still plan', async () => {
    const BAD = '0x00000000000000000000000000000000000000c3'; // decimals() and balanceOf revert
    const { cv } = setup({ listed: [{ token: { address: BAD, symbol: 'BAD', name: 'Bad', decimals: '18', type: 'ERC-20' }, value: '1' }] });
    const p = await cv.plan({ chainId: 369, target: DAI });
    expect(p.unreadable).toEqual([{ address: BAD, symbol: 'BAD', name: 'Bad', why: expect.stringMatching(/^Couldn't read it on-chain: mock: unexpected call/) }]);
    expect(p.rows.some((r) => r.coin.symbol === 'BAD')).toBe(false);
    expect(row(p, 'PLS').ok).toBe(true);
    expect(row(p, 'TKN').balance).toBe(5);
  });

  it('refuses a target that is not a coin of the chain\'s markets, and silly limits', async () => {
    const { cv } = setup();
    await expect(cv.plan({ chainId: 369, target: TKN })).rejects.toThrow(/isn't a coin/);
    await expect(cv.plan({ chainId: 369, target: DAI, maxImpact: 2 })).rejects.toThrow(/price impact/);
    await expect(cv.plan({ chainId: 369, target: DAI, keepNative: -1 })).rejects.toThrow(/keep for gas/);
    expect(cv.targets(369).map((c) => c.symbol)).toEqual(['PLS', 'DAI', 'USDC', 'USDT', 'HEX', 'eHEX', 'PLSX']);
  });
});

describe('Converter: running it', () => {
  it('one coin at a time, one nonce after another; the second swap spends what the first returned', async () => {
    const { cv, chain } = setup();
    const p = await cv.plan({ chainId: 369, target: DAI });
    const dai0 = chain.bal('DAI');
    cv.run(p.id, [NATIVE, HEX, WPLS]);
    const job = await finished(cv);
    expect(job.rows.map((r) => [r.coin.symbol, r.status])).toEqual([['PLS', 'done'], ['WPLS', 'done'], ['HEX', 'done']]);
    expect(chain.sent.map((s) => s.method)).toEqual([
      'swapExactETHForTokens', // PLS → DAI
      'withdraw', 'swapExactETHForTokens', // WPLS → PLS → DAI
      'approve', 'swapExactTokensForETH', 'swapExactETHForTokens', // HEX → PLS → DAI
    ]);
    expect(chain.sent.map((s) => s.nonce)).toEqual([0, 1, 2, 3, 4, 5]);
    // HEX's PLS → DAI spent exactly the PLS its first swap brought in
    const hex = job.rows[2];
    expect(Number(chain.sent[5].value) / 1e18 / hex.steps[0].out!).toBeCloseTo(1, 12);
    // everything went to DAI; what was kept for gas stayed
    const got = job.rows.reduce((a, r) => a + r.out!, 0);
    expect(Number(chain.bal('DAI') - dai0) / 1e18).toBeCloseTo(got, 9);
    expect(chain.balances.get(WPLS)).toBe(0n);
    expect(chain.bal('HEX')).toBe(0n);
    expect(Number(chain.pls) / 1e18).toBeGreaterThan(99_000);
    expect(Number(chain.pls) / 1e18).toBeLessThan(100_001);
  });

  it('a coin a bot started using after the plan is left with the bot', async () => {
    const alloc: Allocation[] = [];
    const { cv, chain } = setup({ allocations: alloc });
    const p = await cv.plan({ chainId: 369, target: DAI });
    alloc.push({ chainId: 369, address: HEX, native: false, allocated: 5_000 });
    cv.run(p.id, [HEX]);
    const job = await finished(cv);
    expect(job.rows[0]).toMatchObject({ status: 'failed', error: expect.stringMatching(/used by a bot/) });
    expect(chain.sent).toEqual([]);
  });

  it('stop: the coin being converted finishes, the rest are left', async () => {
    const { cv, chain } = setup();
    const p = await cv.plan({ chainId: 369, target: DAI });
    chain.onSend = () => cv.stop();
    cv.run(p.id, [NATIVE, HEX]);
    const job = await finished(cv);
    expect(job.rows.map((r) => r.status)).toEqual(['done', 'stopped']);
    expect(chain.bal('HEX')).toBe(5_000n * 10n ** 8n);
  });

  it('stop once a coin\'s first transaction is out: that coin still ends in the target, not halfway', async () => {
    // stop on WPLS's unwrap: its swap still goes; HEX (next in the plan) is left
    const a = setup();
    const pa = await a.cv.plan({ chainId: 369, target: DAI });
    const dai0 = a.chain.bal('DAI');
    a.chain.onSend = () => a.cv.stop();
    a.cv.run(pa.id, [WPLS, HEX]);
    const ja = await finished(a.cv);
    expect(ja.rows.map((r) => [r.coin.symbol, r.status])).toEqual([['WPLS', 'done'], ['HEX', 'stopped']]);
    expect(a.chain.sent.map((s) => s.method)).toEqual(['withdraw', 'swapExactETHForTokens']);
    expect(Number(a.chain.bal('DAI') - dai0) / 1e18).toBeCloseTo(ja.rows[0].out!, 9);
    expect(a.chain.bal('HEX')).toBe(5_000n * 10n ** 8n);
    // stop on HEX's approve: both its swaps still go
    const b = setup();
    const pb = await b.cv.plan({ chainId: 369, target: DAI });
    b.chain.onSend = () => b.cv.stop();
    b.cv.run(pb.id, [HEX]);
    const jb = await finished(b.cv);
    expect(jb.rows[0].status).toBe('done');
    expect(b.chain.sent.map((s) => s.method)).toEqual(['approve', 'swapExactTokensForETH', 'swapExactETHForTokens']);
    expect(b.chain.bal('HEX')).toBe(0n);
  });

  it('refuses a stale or unknown plan, nothing chosen, and a second run at once', async () => {
    let t = 1_800_000_000_000;
    const { hub, chain } = setup();
    const cv = new Converter({ hub, allocations: () => [], approval: 'exact', fetchJson: async () => ({ items: [], next_page_params: null }), now: () => t, pollMs: 1 });
    const p = await cv.plan({ chainId: 369, target: DAI });
    expect(() => cv.run('cv-other', [NATIVE])).toThrow(/plan is gone/);
    expect(() => cv.run(p.id, [TKN])).toThrow(/Nothing chosen/);
    t += PLAN_TTL_MS + 1;
    expect(() => cv.run(p.id, [NATIVE])).toThrow(/10 minutes old/);
    t -= PLAN_TTL_MS + 1;
    chain.onSend = () => { expect(() => cv.run(p.id, [HEX])).toThrow(/already running/); };
    cv.run(p.id, [NATIVE]);
    await finished(cv);
  });
});
