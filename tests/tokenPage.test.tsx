/** The Token trader page (src/ui/TokenTraderPage.tsx) and its figures (src/ui/tokenModel.ts). */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { TokenTraderPage } from '../src/ui/TokenTraderPage';
import { SmartTrader } from '../src/ui/SmartTrader';
import { STYLES, ladderRungs, ladderX, radarBlips, scorecard, styleOf, timeUsed } from '../src/ui/tokenModel';
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

describe('exit ladder', () => {
  it('runs from the −25% stop to the +100% take profit; taken take profits are marked', () => {
    expect(ladderX(-0.25)).toBe(0);
    expect(ladderX(1)).toBe(1);
    expect(ladderX(0)).toBeCloseTo(0.2, 12);
    expect(ladderX(-0.9)).toBe(0);
    expect(ladderX(4)).toBe(1);
    const r = ladderRungs({ tp1Done: true, tp2Done: false });
    expect(r.map((x) => [x.key, x.done])).toEqual([['stop', false], ['zero', false], ['arm', false], ['tp1', true], ['tp2', false]]);
    expect(timeUsed(NOW - 3 * 3600_000, NOW)).toBeCloseTo(0.5, 12);
    expect(timeUsed(NOW - 9 * 3600_000, NOW)).toBe(1);
    expect(timeUsed(Number(undefined), NOW)).toBe(0); // a position saved without its open time
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
    const [a] = radarBlips([f], NOW), [b] = radarBlips([{ ...f, t: NOW - 60 * 60_000 }], NOW);
    expect([a.x, a.y]).toEqual([b.x, b.y]);
    expect(Math.hypot(a.x - 50, a.y - 50)).toBeLessThanOrEqual(50);
    expect(a).toMatchObject({ tone: 'bought', fade: 1 });
    expect(b.fade).toBe(0.2);
    expect(radarBlips([{ ...f, verdict: 'skipped', stage: 'checks' }], NOW)[0].tone).toBe('checks');
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
    expect(html).toMatch(/class="tk-ladder"/);
    expect(html).toMatch(/Scorecard/);
    expect(html).toMatch(/Advanced/);
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
