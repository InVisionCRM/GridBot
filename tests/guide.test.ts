import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Guide, GUIDE_SECTIONS } from '../src/Guide';
import { STRATEGY_PRESETS } from '../src/live/presets';

describe('Guide', () => {
  const html = renderToStaticMarkup(createElement(Guide, { onClose: () => undefined }));

  it('renders as a dialog with every section and the level diagram', () => {
    expect(html).toContain('role="dialog"');
    expect(html).toContain('<svg');
    for (const [id, label] of GUIDE_SECTIONS) {
      expect(html, id).toContain(`id="g-${id}"`);
      expect(html, label).toContain(label.replace('&', '&amp;'));
    }
    expect(html.match(/class="g-buy"/g)!.length).toBeGreaterThan(2);
    expect(html.match(/class="g-sell"/g)!.length).toBeGreaterThan(2);
  });

  it('shows the real fee math, gate thresholds and limits', () => {
    expect(html).toContain('0.29%'); // per swap
    expect(html).toContain('0.579%'); // per round-trip
    expect(html).toContain('1.0%'); // spacing floor
    expect(html).toContain('0.25%'); // net margin
    expect(html).toMatch(/Default 3%, max 5%/); // impact
    expect(html).toMatch(/Default 1%, max 5%/); // slippage
    expect(html).toMatch(/2–50/); // grid count
  });

  it('lists every preset with its live params', () => {
    for (const p of STRATEGY_PRESETS) {
      expect(html, p.id).toContain(p.name.replace('&', '&amp;'));
      expect(html, p.id).toContain(`±${(p.legs[0].bandPct * 100).toFixed(0)}% × ${p.legs[0].gridCount}`);
    }
  });

  it('documents the fills columns and never names the key variable', () => {
    for (const col of ['Trig', 'Quote', 'Exec', 'Slip', 'Gas', 'RT net']) expect(html).toContain(`<td>${col}</td>`);
    expect(/PRIVATE_KEY|privateKey/.test(html)).toBe(false);
  });

  it('documents the trend bot, backtester, charts and analytics from the code constants', () => {
    for (const id of ['trend', 'backtest', 'charts', 'analytics']) expect(html).toContain(`id="g-${id}"`);
    expect(html).toContain('EMA cross');
    expect(html).toContain('Donchian breakout');
    expect(html).toMatch(/No look-ahead/);
    expect(html).toMatch(/GeckoTerminal/);
    expect(html).toMatch(/Cost gate/);
    expect(html).toContain('1m / 5m / 15m / 1h / 4h / 1d');
  });

  it('is wired into the main UI behind a Guide button', () => {
    const app = readFileSync(join(__dirname, '..', 'src', 'App.tsx'), 'utf8');
    expect(app).toMatch(/onClick=\{\(\) => setGuide\(true\)\}>Guide</);
    expect(app).toContain('<Guide onClose={closeGuide} />');
  });
  it('documents chains, PulseChain DEXes (PulseX V1/V2, 9mm) and the custom-token policy', () => {
    for (const x of ['PulseX V1 (V2, 0.29%)', 'PulseX V2 (V2, 0.29%)', '9mm V2 (V2, 0.25%)', '9mm V3 (V3', 'Robinhood Chain', 'Base', 'paper-only', 'Auto: best quote']) expect(html, x).toContain(x);
  });
});
