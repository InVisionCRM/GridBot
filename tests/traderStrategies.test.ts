/**
 * The two auto traders' strategies (Kyle 2026-11-08): the smart trader's presets and what each would open now with a
 * budget (market/smartStrategy.ts, server/bot/autopilot.ts strategies), the token trader's presets, the gate's rules in
 * words and the exit-ladder arithmetic (market/tokenStrategy.ts), and the cards (ui/TraderStrategyCards.tsx).
 */
import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { SMART_STRATEGY, SMART_STRATEGY_IDS, previewWeek, smartStrategyOf, type SmartPreview, type SmartStrategyId } from '../src/market/smartStrategy';
import { TOKEN_STRATEGY, ladderOutcome, stopsPaidFor, tokenProfile, tokenStrategyOf } from '../src/market/tokenStrategy';
import { Autopilot, DEFAULT_OPTIONS, checkOptions, type AutopilotState, type ScanView } from '../src/server/bot/autopilot';
import { MultiBot, type MultiState } from '../src/server/bot/multi';
import { Logger } from '../src/server/bot/logger';
import { MemoryStore } from '../src/server/bot/store';
import type { Opportunity } from '../src/market/scan';
import { MockChain, NET } from './helpers/mockChain';
import { LadderPanel, SmartStrategyCards, TokenStrategyCards } from '../src/ui/TraderStrategyCards';
import { SmartTrader } from '../src/ui/SmartTrader';
import { TokenTraderPage } from '../src/ui/TokenTraderPage';
import { EthUsdCtx } from '../src/ui/units';
import { S, TRADER } from './helpers/unitsScreens';

const P0 = 0.00001;
const NOW = 1_800_000_000_000;
/** The page's words: inline emphasis tags vanish, other tags become a space, React's escapes are undone */
const text = (html: string) => html.replace(/<\/?(b|small|em|i)>/g, '').replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, '\'').replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/\s+/g, ' ');

/** A pool as the scan shows it: a grid that earned on a price swinging `swing` a day; `o` overrides */
function opp(key: string, swing: number, o: Partial<Opportunity> = {}): Opportunity {
  const q = NET.quotes.find((x) => x.symbol === key)!;
  return {
    chainId: NET.chainId, key, ref: { address: NET.pulsex.wpls, quote: q.address, pool: '' }, label: `PLS/${key}`, spend: key, stack: 'PLS', dex: 'pulsex-v2', kind: 'v2', feeBps: 29,
    risk: null, riskWhy: null, liveAllowed: true, price: P0, movePct: 0, swingPct: swing, activity: null, capital: 1e6, usd: 1e6,
    grid: { bandPct: 0.12, gridCount: 10, earnedPct: 0.02, roundTrips: 8, returnPct: 0, maxDrawdownPct: 0 }, gridWhy: null, lp: null, lpWhy: 'v2', ...o,
  };
}
const LP = { bandPct: 0.08, earnedPct: 0.05, feesPct: 0.06, inRangePct: 0.9, poolSharePct: 0.01, returnPct: 0.04 };
/** PLS/DAI (a grid), HEX/PLS (a grid and a range, low risk, reached by a swap into PLS), and a new coin not in the app yet (medium risk) */
const ITEMS: Opportunity[] = [
  opp('DAI', 0.3),
  opp('DAI', 0.5, { key: 'HEX~', label: 'HEX/PLS', spend: 'PLS', stack: 'HEX', capital: 1e8, kind: 'v3', risk: 'low', lp: LP, lpWhy: null }),
  opp('DAI', 0.8, { key: null, ref: { address: '0x' + '22'.repeat(20), quote: NET.quotes.find((x) => x.symbol === 'DAI')!.address, pool: '0x' + '33'.repeat(20) }, label: 'NEW/DAI', stack: 'NEW', risk: 'medium', riskWhy: 'a tax' }),
];
const view = (items: Opportunity[], o: { partial?: boolean; chainId?: number } = {}): ScanView => ({ at: NOW, chains: [{ chainId: o.chainId ?? NET.chainId, at: NOW, items, error: null, ...(o.partial ? { partial: true } : {}) }] });

function trader(scan: ScanView = view(ITEMS)) {
  const chain = new MockChain(P0);
  const bot = new MultiBot({ net: NET, reader: chain, signer: chain, store: new MemoryStore<MultiState>(), log: new Logger(true), maxRetries: 1, retryDelayMs: 0, now: () => NOW });
  const ap = new Autopilot({ bot, store: new MemoryStore<AutopilotState>(), emit: () => undefined, scan: async () => scan, now: () => NOW });
  return ap;
}

describe('the smart trader\'s strategies', () => {
  it('each preset is a complete, valid set of options; the default and anything changed by hand are none of them', () => {
    for (const id of SMART_STRATEGY_IDS) {
      expect(checkOptions(SMART_STRATEGY[id].options)).toEqual(SMART_STRATEGY[id].options);
      expect(smartStrategyOf(SMART_STRATEGY[id].options)).toBe(id);
    }
    expect(smartStrategyOf(DEFAULT_OPTIONS)).toBeNull();
    expect(smartStrategyOf({ ...SMART_STRATEGY.wide.options, slots: 5 })).toBeNull();
    expect(SMART_STRATEGY.farmer.options).toMatchObject({ lp: true, grid: false, newTokens: false, risk: 'safe' });
    expect(SMART_STRATEGY.swing.options).toMatchObject({ grid: true, lp: false, newTokens: true, risk: 'medium' });
    expect(SMART_STRATEGY.wide.options).toMatchObject({ grid: true, lp: true, newTokens: true, risk: 'any', slots: 6 });
  });
  it('the budget\'s week is each pick\'s score on its money, over the whole amount', () => {
    expect(previewWeek([{ score: 0.02, capital: 100 }, { score: 0.04, capital: 100 }], 400)).toBeCloseTo(0.015, 12);
    expect(previewWeek([], 400)).toBeNull();
  });

  it('what each would open now with 300 DAI: the farmer a range on the low-risk pool, the swing grids three grids, the wide net the best way per pair', async () => {
    const ap = trader();
    const p = await ap.strategies({ chainId: NET.chainId, coin: 'DAI', amount: 300 });
    const farmer = p.farmer, swing = p.swing, wide = p.wide;
    expect(farmer.ready && swing.ready && wide.ready).toBe(true);
    expect(farmer.pools).toBe(3);
    // the farmer: only HEX/PLS has a range; it costs a swap into PLS and back (two pool fees), netted from its estimate
    expect(farmer.opens.map((x) => [x.label, x.how])).toEqual([['HEX/PLS', 'lp']]);
    expect(farmer.opens[0].expected).toBeCloseTo(0.77 * 0.05, 9);
    expect(farmer.opens[0].cost).toBeCloseTo(2 * 29 / 10_000, 12);
    expect(farmer.opens[0].score).toBeCloseTo(0.77 * 0.05 - 0.0058, 9);
    expect(farmer.opens[0].capital).toBeCloseTo(300, 6);
    expect(farmer.weekPct).toBeCloseTo(farmer.opens[0].score, 12);
    expect(farmer.waiting).toBeCloseTo(0, 9);
    // PLS/DAI's grid and HEX/PLS's grid are off; PLS/DAI has no range (its lpWhy); the new coin fails the risk rule before the new-tokens rule
    expect(farmer.gone.map((g) => g.why).sort()).toEqual(['grids are off', 'its risk is medium, above what you allowed', 'v2']);
    // the swing grids: every grid, the new coin too (medium risk allowed), best swing first, the money split evenly
    expect(swing.opens.map((x) => [x.label, x.how])).toEqual([['NEW/DAI', 'grid'], ['HEX/PLS', 'grid'], ['PLS/DAI', 'grid']]);
    expect(swing.opens[0].expected).toBeCloseTo(0.0686 * 0.8, 9);
    for (const x of swing.opens) expect(x.capital).toBeCloseTo(100, 6);
    expect(swing.weekPct).toBeCloseTo(swing.opens.reduce((s, x) => s + x.score * x.capital, 0) / 300, 12);
    // the wide net: one bot per pair, the better way of HEX/PLS (its range beats its grid)
    expect(wide.opens.map((x) => [x.label, x.how])).toEqual([['NEW/DAI', 'grid'], ['HEX/PLS', 'lp'], ['PLS/DAI', 'grid']]);
    expect(wide.allowed).toBe(4); // PLS/DAI grid, HEX/PLS grid and range, NEW/DAI grid
  });

  it('a chain still being scanned, or not in the scan, has no preview and says why; a bad budget is refused', async () => {
    const partial = await trader(view(ITEMS, { partial: true })).strategies({ chainId: NET.chainId, coin: 'DAI', amount: 300 });
    expect(partial.farmer).toMatchObject({ ready: false, why: 'it is still being scanned', opens: [], waiting: 300 });
    const missing = await trader(view(ITEMS, { chainId: 1 })).strategies({ chainId: NET.chainId, coin: 'DAI', amount: 300 });
    expect(missing.wide).toMatchObject({ ready: false, why: 'the chain is not in the scan' });
    await expect(trader().strategies({ chainId: NET.chainId, coin: 'DAI', amount: 0 })).rejects.toThrow(/Enter an amount/);
  });

  it('a preview prices coins into a map of its own: the rates the accounts use are untouched', async () => {
    const ap = trader();
    ap.configure({ mode: 'paper', options: { ...DEFAULT_OPTIONS }, budgets: [{ chainId: NET.chainId, coin: 'DAI', amount: 300 }] });
    const p = await ap.strategies({ chainId: NET.chainId, coin: 'PLS', amount: 3e7 });
    expect(p.wide.opens.some((x) => x.label === 'PLS/DAI')).toBe(true); // DAI was priced in PLS for the preview
    expect((ap as unknown as { rates: Map<string, number> }).rates.size).toBe(0);
  });
});

describe('the token trader\'s strategies', () => {
  it('a strategy is the risk level and the checks; "Use this" also sets the pool age and the sniper', () => {
    expect(tokenStrategyOf(TOKEN_STRATEGY.careful.patch)).toBe('careful');
    expect(tokenStrategyOf({ ...TOKEN_STRATEGY.careful.patch, enforceHolderCheck: false })).toBeNull();
    expect(tokenStrategyOf({ risk: 'any' })).toBe('wild'); // a saved file without the checks reads them as off
    expect(tokenStrategyOf({ ...TOKEN_STRATEGY.wild.apply, perTradeUsd: 5 })).toBe('wild');
    expect(TOKEN_STRATEGY.careful.apply).toMatchObject({ minPoolAgeSec: 86_400, sniper: { on: false }, enforceLiquidityFloor: true });
    expect(TOKEN_STRATEGY.balanced.apply).toMatchObject({ minPoolAgeSec: 3600, sniper: { on: false }, risk: 'medium', enforceSizeImpact: true });
    expect(TOKEN_STRATEGY.wild.apply).toMatchObject({ minPoolAgeSec: 0, sniper: { on: true }, risk: 'any', enforceWashAndAge: false });
  });
  it('the ladder: a run to +100% sells a third at +50%, a third at +100% and the rest 20% under the peak, +70%; one pays for 2.8 stops', () => {
    const run = ladderOutcome(1);
    expect(run.sold.map((s) => [+s.at.toFixed(4), +s.frac.toFixed(4)])).toEqual([[0.5, 0.3333], [1, 0.3333], [0.6, 0.3333]]);
    expect(run.total).toBeCloseTo(0.7, 9);
    expect(ladderOutcome(2).total).toBeCloseTo((0.5 + 1 + 1.4) / 3, 9);
    expect(ladderOutcome(0.4)).toMatchObject({ sold: [{ at: expect.closeTo(0.12, 9), frac: 1 }], total: expect.closeTo(0.12, 9) });
    expect(stopsPaidFor(1)).toBeCloseTo(2.8, 9);
    expect(() => ladderOutcome(0.2)).toThrow(/arms at \+30%/);
  });
  it('the coins each buys, as the gate\'s rules with their numbers; money the page\'s way, never a dollar', () => {
    const money = (usd: number) => `≈ ${(usd / 2300).toFixed(2)} ETH`;
    const sniper = { delayBlocks: 2, delaySec: 15, maxPerHour: 3, minLiquidityUsd: 5000 };
    const careful = tokenProfile('careful', 86_400, sniper, money).join('\n');
    expect(careful).toContain('pool at least 1 day old, real volume: under 20× its liquidity in a day');
    expect(careful).toContain('at least ≈ 21.74 ETH of liquidity; holders spread: the largest under 10%, the top 10 under 40%');
    expect(careful).toContain('your own buy moves the price under 1%');
    expect(careful).toContain('no tax at all; not upgradeable');
    const balanced = tokenProfile('balanced', 3600, sniper, money).join('\n');
    expect(balanced).toContain('pool at least 1 h old');
    expect(balanced).toMatch(/a tax up to \d+% is fine/);
    expect(balanced).toContain('no holder check and no liquidity floor');
    const wild = tokenProfile('wild', 0, sniper, money).join('\n');
    expect(wild).toContain('the sniper buys a brand-new pool 2 blocks (15 s) after its liquidity lands, from ≈ 2.17 ETH of liquidity, at most 3 an hour');
    expect(wild).toContain('always refused: a honeypot');
    expect(`${careful}${balanced}${wild}`).not.toContain('$');
  });
});

describe('the cards', () => {
  const pick = (label: string, how: 'grid' | 'lp', score: number, capital: number) => ({ label, how, dex: 'd', expected: score + 0.0058, cost: 0.0058, entry: 0, score, capital, risk: 'low', movePct: 0 });
  const ready = (opens: ReturnType<typeof pick>[], amount: number): SmartPreview => ({ ready: true, why: null, scanAt: NOW, pools: 3, allowed: 4, opens, waiting: amount - opens.reduce((s, x) => s + x.capital, 0), waitWhy: null, weekPct: previewWeek(opens, amount), gone: [] });
  it('the smart trader\'s three cards, each with its picture; with no budget they ask for one', () => {
    const html = renderToStaticMarkup(createElement(SmartStrategyCards, { chosen: 'farmer', onChoose: () => undefined, rows: [], previews: {} }));
    for (const id of SMART_STRATEGY_IDS) expect(html).toContain(`data-testid="smart-strategy-${id}"`);
    expect(html).toContain('class="sx sx-f"'); expect(html).toContain('class="sx sx-g"'); expect(html).toContain('class="sx sx-n"');
    expect(html).toContain('>Chosen<');
    expect((html.match(/>Use this</g) ?? []).length).toBe(2);
    expect(text(html)).toContain('Enter a budget above to see the pools it would open now, and their week.');
    expect(text(html)).toContain('liquidity ranges · coins already in the app · risk low only · 3 pools · loss limit 10%');
    expect(text(html)).toContain('the top tenth was expected to earn 14.1% a week and earned 12.5% (rank correlation 0.73)');
  });
  it('with a budget typed in, each card lists what it would open now, the money that waits, and the budget\'s week', () => {
    const rows = [{ chainId: 369, chain: 'PulseChain', coin: 'DAI', amount: 300 }];
    const previews: Record<number, Record<SmartStrategyId, SmartPreview>> = {
      369: { farmer: ready([pick('HEX/PLS', 'lp', 0.0327, 300)], 300), swing: ready([pick('NEW/DAI', 'grid', 0.0549, 100), pick('PLS/DAI', 'grid', 0.0206, 100)], 300), wide: { ...ready([], 300), waitWhy: 'nothing earned at this size' } },
    };
    const t = text(renderToStaticMarkup(createElement(SmartStrategyCards, { chosen: null, onChoose: () => undefined, rows, previews })));
    expect(t).toContain('PulseChain · 300 DAI');
    expect(t).toContain('HEX/PLS as a range · 300 DAI · ≈ +3.3% a week after 0.6% to get in and out');
    expect(t).toContain('≈ +3.3% on the budget this week, if the estimates hold');
    expect(t).toContain('NEW/DAI as a grid · 100 DAI · ≈ +5.5% a week');
    expect(t).toContain('100 DAI waits');
    expect(t).toContain('nothing opens now: nothing earned at this size (4 of 3 pools allowed)'.replace('4 of 3', '4 of 3'));
    const loading = text(renderToStaticMarkup(createElement(SmartStrategyCards, { chosen: null, onChoose: () => undefined, rows, previews: {} })));
    expect(loading).toContain("reading today's scan…");
    const failed = text(renderToStaticMarkup(createElement(SmartStrategyCards, { chosen: null, onChoose: () => undefined, rows, previews: { 369: { error: 'That chain is not on.' } } })));
    expect(failed).toContain('That chain is not on.');
  });
  it('the token trader\'s three cards with their funnels, the rules in ETH, and one ladder panel for all three', () => {
    const html = renderToStaticMarkup(createElement(EthUsdCtx.Provider, { value: 2300 }, createElement(TokenStrategyCards, { o: { ...TOKEN_STRATEGY.balanced.apply, sniper: { on: false, delayBlocks: 2, delaySec: 15, maxPerHour: 3, minLiquidityUsd: 5000 } }, onChoose: () => undefined })));
    for (const id of ['careful', 'balanced', 'wild']) { expect(html).toContain(`data-testid="token-strategy-${id}"`); expect(html).toContain(`class="sx sx-t sx-t-${id}"`); }
    expect(html).toContain('<b>Careful</b>'); expect(html).toContain('<b>Balanced</b>'); expect(html).toContain('<b>Wild</b>');
    expect(html).toContain('class="strat-card tk-strat balanced on"');
    const t = text(html);
    expect(t).toContain('at least 21.74 ETH of liquidity');
    expect(t).toContain('a third at +50% (+50%), a third at +100% (+100%), the rest 20% under the peak (+60%): +70% on the trade. One such run pays for 2.8 trades that stopped out.');
    expect(t).toContain('Runs to +200% and turns: +97%; one pays for 3.9 stops.');
    expect(html).not.toContain('$');
    expect(html).toContain('data-testid="ladder-panel"');
    expect(renderToStaticMarkup(createElement(LadderPanel))).toContain('class="sx sx-l"');
  });
  it('the pages carry the cards: the Smart trader\'s setup and the token trader\'s step 1', () => {
    const smart = renderToStaticMarkup(createElement(SmartTrader, { s: S, nav: () => undefined }));
    // the setup form shows once the trader's state has loaded; the static render has none, so only the switch and the loading line
    expect(smart).toContain('class="tk-switch"');
    const token = renderToStaticMarkup(createElement(TokenTraderPage, { s: S, nav: () => undefined, seed: TRADER, now: NOW }));
    expect(token).toContain('data-testid="token-strategy-cards"');
    expect(token).toContain('data-testid="ladder-panel"');
    expect(token).toContain('Strategy');
  });
});
