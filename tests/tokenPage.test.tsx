/** The Token trader page (src/ui/TokenTraderPage.tsx) and its figures (src/ui/tokenModel.ts). */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { TokenTraderPage } from '../src/ui/TokenTraderPage';
import { SmartTrader } from '../src/ui/SmartTrader';
import { DEPTH, STYLES, lookCycle, radarBlips, radarSectors, scorecard, styleOf } from '../src/ui/tokenModel';
import { normalizeView } from '../src/ui/model';
import { S, TRADER } from './helpers/unitsScreens';

const NOW = 1_800_000_000_000;

describe('token trader styles', () => {
  it('each style matches itself and nothing else; a hand-set mix is Custom (null)', () => {
    for (const st of STYLES) expect(styleOf({ ...st.patch, perTradeUsd: 5 })).toBe(st.id);
    expect(styleOf({ ...STYLES[0].patch, enforceHolderCheck: false })).toBeNull();
    // a saved file without the optional checks reads them as off
    expect(styleOf({ risk: 'any' })).toBe('wild');
  });
});

describe('scorecard and radar', () => {
  it('counts closed sells with a result; best and worst by result', () => {
    const sc = scorecard([
      { side: 'buy', pnlUsd: null },
      { side: 'sell', label: 'A', pnlUsd: 5, pnl: 0.002, spendSym: 'WETH' },
      { side: 'sell', label: 'B', pnlUsd: -3, pnl: -0.001, spendSym: 'WETH' },
      { side: 'sell', label: 'C', pnlUsd: 1, pnl: 0.0004, spendSym: 'WETH' },
    ]);
    expect(sc).toMatchObject({ sells: 3, wins: 2, best: { label: 'A' }, worst: { label: 'B' } });
    expect(sc.winRate).toBeCloseTo(2 / 3, 12);
    expect(scorecard([]).winRate).toBeNull();
  });
  it('a pool lands on the same spot every time, inside the radar; old blips fade but never vanish', () => {
    const f = { chainId: 1, pool: '0xabc', t: NOW, verdict: 'bought', label: 'X/WETH' };
    const [a] = radarBlips([f], NOW, [1]), [b] = radarBlips([{ ...f, t: NOW - 60 * 60_000 }], NOW, [1]);
    expect([a.x, a.y]).toEqual([b.x, b.y]);
    expect(Math.hypot(a.x - 50, a.y - 50)).toBeLessThanOrEqual(50);
    expect(a).toMatchObject({ tone: 'bought', fade: 1 });
    expect(b.fade).toBe(0.2);
    expect(radarBlips([{ ...f, verdict: 'skipped', stage: 'checks' }], NOW, [1])[0].tone).toBe('checks');
  });
  it("a blip sits in its chain's slice, as deep as the coin got; a chain the trader doesn't read has no slice", () => {
    const chains = [369, 4663, 1];
    const sectors = radarSectors(chains);
    const at = (stage: string, verdict = 'skipped') => radarBlips([{ chainId: 4663, pool: '0xabc', t: NOW, verdict, stage, label: 'X' }], NOW, chains)[0];
    for (const [stage, tone] of [['rules', 'rules'], ['checks', 'checks'], ['buy', 'buy']] as const) {
      const b = at(stage);
      const r = Math.hypot(b.x - 50, b.y - 50) / 50;
      expect(Math.abs(r - DEPTH[tone])).toBeLessThanOrEqual(0.05 + 1e-9);
      let ang = Math.atan2(b.y - 50, b.x - 50);
      const s = sectors[1];
      while (ang < s.from) ang += 2 * Math.PI;
      expect(ang).toBeLessThan(s.to);
    }
    expect(Math.hypot(at('buy', 'bought').x - 50, at('buy', 'bought').y - 50) / 50).toBeLessThan(DEPTH.checks);
    expect(radarBlips([{ chainId: 8453, pool: '0xabc', t: NOW, stage: 'rules', label: 'X' }], NOW, chains)).toEqual([]);
  });
  it('the discovery cycle: time since the last run and until the next; none before the first run', () => {
    expect(lookCycle({ last: { at: NOW - 12_000, found: 3 }, everyMs: 30_000 }, NOW)).toEqual({ elapsed: 12_000, everyMs: 30_000, inMs: 18_000 });
    expect(lookCycle({ last: { at: NOW - 45_000, found: 3 }, everyMs: 30_000 }, NOW)?.inMs).toBe(0);
    expect(lookCycle({ last: null, everyMs: 30_000 }, NOW)).toBeNull();
  });
});

describe('the page', () => {
  const render = () => renderToStaticMarkup(createElement(TokenTraderPage, { s: S, nav: () => undefined, seed: TRADER, now: NOW }));
  it('has the trader switch, the hero, the radar, the funnel, the three setup steps, positions on ladders and the scorecard', () => {
    const html = render();
    expect(html).toMatch(/class="tk-switch"/);
    expect(html).toMatch(/aria-pressed="true"[^>]*>.*Token trader/);
    expect(html).toMatch(/Hunting new pools/); // TRADER is on
    expect(html).toMatch(/class="tk-radar on"/);
    expect(html).toMatch(/Today&#x27;s funnel/);
    for (const st of ['Careful', 'Balanced', 'Wild']) expect(html).toContain(`<b>${st}</b>`);
    expect(html).toMatch(/How much/);
    expect(html).toMatch(/Sell now/);
    expect(html).toMatch(/Stop-loss/);
    expect(html).toMatch(/Scorecard/);
    expect(html).toMatch(/Advanced/);
    // nothing on the page loops on its own: motion comes from runs, coins and counts
    expect(html).not.toMatch(/tk-flow|tk-cross/);
  });
  it('the radar says when the next look is and what the last one found', () => {
    const html = renderToStaticMarkup(createElement(TokenTraderPage, { s: S, nav: () => undefined, seed: { ...TRADER, look: { last: { at: NOW - 10_000, found: 7 }, everyMs: 30_000 } }, now: NOW }));
    expect(html).toMatch(/next look in 20 s · last look found 7 pools/);
    expect(html).toMatch(/class="tk-sweep" style="animation-duration:30000ms;animation-delay:-/);
  });
  it('the Smart trader page has the switch and no longer carries the token trader', () => {
    const html = renderToStaticMarkup(createElement(SmartTrader, { s: S, nav: () => undefined }));
    expect(html).toMatch(/class="tk-switch"/);
    expect(html).toMatch(/aria-pressed="true"[^>]*>.*Smart trader/);
    expect(html).not.toMatch(/id="token-trader"/);
  });
  it('the token page is restored after a reload', () => {
    expect(normalizeView({ v: 'token' })).toEqual({ v: 'token' });
  });
});
