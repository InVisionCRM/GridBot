/** The Token trader page (src/ui/TokenTraderPage.tsx) and its figures (src/ui/tokenModel.ts). */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ExitLine, TokenTraderPage } from '../src/ui/TokenTraderPage';
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
    // positions are cards: a front and a back to flip between, the exit track, the time stop, Exits closed, Sell now
    expect(html).toMatch(/<article class="tk-pc up ">/);
    expect(html).toMatch(/class="tk-pc-face tk-pc-front" aria-hidden="false"/);
    expect(html).toMatch(/class="tk-pc-face tk-pc-back" aria-hidden="true"/);
    expect(html).toMatch(/class="tk-pc-flipbtn" tabindex="0">Flip/);
    expect(html).toMatch(/<dt>Bought at<\/dt>/);
    expect(html).toMatch(/<dt>Highest since buy<\/dt><dd>\+7.1% vs the buy<\/dd>.*<dt>Sell tax<\/dt><dd>0.0%<\/dd>/);
    expect(html).not.toMatch(/NaN/);
    expect(html).toMatch(/class="tk-pc-drop" aria-expanded="false">Exits/);
    expect(html).not.toMatch(/tk-pc-exits/);
    expect(html).toMatch(/<button type="button" class="tk-sell">Sell now<\/button>/);
    expect(html).toMatch(/Scorecard/);
    expect(html).toMatch(/Advanced/);
    // nothing on the page loops on its own: motion comes from runs, coins and counts
    expect(html).not.toMatch(/tk-flow|tk-cross/);
  });
  it('a card with a price read shows the exit track: the result now between the stop and the last take-profit, and the time stop', () => {
    const exits = [
      { key: 'stop', does: 'sells all at −25%', move: -0.25, at: -0.25 },
      { key: 'trail', does: 'arms at +30%', move: 0.3, at: 0.3, armed: false },
      { key: 'tp1', does: 'sells a third at +50%', move: 0.5, at: 0.5, done: false },
      { key: 'tp2', does: 'sells a third at +100%', move: 1, at: 1, done: false },
      { key: 'time', does: 'sells all at 6 h if under +10%', move: null, msLeft: 5 * 3600_000, ms: 6 * 3600_000 },
    ];
    const seed = { ...TRADER, positions: TRADER.positions.map((p: Record<string, unknown>) => ({ ...p, exits })) };
    const html = renderToStaticMarkup(createElement(TokenTraderPage, { s: S, nav: () => undefined, seed, now: NOW }));
    // at the buy (result 0): the dot a fifth of the way along, labels at the stop, the trail, the first and last take-profit
    expect(html).toMatch(/aria-label="result \+0.0%: stop at −25%, last take-profit at \+100%"/);
    expect(html).toMatch(/class="tk-pc-dot up" style="left:20%"/);
    expect(html).toMatch(/<span class="is-stop" style="left:0%">−25%<\/span><span class="is-trail" style="left:44%">\+30%<\/span><span class="is-tp1" style="left:60%">\+50%<\/span><span class="is-tp2" style="left:100%">\+100%<\/span>/);
    expect(html).toMatch(/<span>Time stop<\/span>.*width:16.66.*5h 00m left/);
  });
  it('an exit line says what the rule does and how far the price is from it', () => {
    const line = (x: Record<string, unknown>) => renderToStaticMarkup(createElement(ExitLine, { x: { does: 'sells all at −25%', ...x } }));
    expect(line({ key: 'stop', move: -0.251 })).toMatch(/<b>Stop-loss<\/b><small>sells all at −25%<\/small><\/span><em>−25.1% away<\/em>/);
    expect(line({ key: 'trail', armed: false, move: 0.3 })).toMatch(/<b>Trailing stop \(not armed\)<\/b>.*<em>\+30.0% away<\/em>/);
    expect(line({ key: 'tp1', done: true })).toMatch(/class="tk-pc-exit is-tp1 done".*<em>taken<\/em>/);
    expect(line({ key: 'time', msLeft: 3_420_000 })).toMatch(/<b>Time stop<\/b>.*<em>0h 57m left<\/em>/);
    expect(line({ key: 'time', msLeft: 0, does: 'off: up over +10%' })).toMatch(/<em>off<\/em>/);
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
