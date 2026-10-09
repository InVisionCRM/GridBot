import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Guide, GUIDE_SECTIONS } from '../src/Guide';
import { STRATEGY_PRESETS } from '../src/live/presets';
import { CHAINS } from '../src/live/chains';

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

  it('shows the real fee math, start-check thresholds and limits', () => {
    expect(html).toContain('0.29%'); // per swap
    expect(html).toContain('0.579%'); // per round-trip
    expect(html).toContain('1.0%'); // spacing floor
    expect(html).toContain('0.25%'); // net margin
    expect(html).toMatch(/Default 3%, max 5%/); // impact
    expect(html).toMatch(/Default 1%, max 5%/); // slippage
    expect(html).toMatch(/2–50/); // level count
  });

  it('lists every preset with its live params', () => {
    for (const p of STRATEGY_PRESETS) {
      expect(html, p.id).toContain(p.name.replace('&', '&amp;'));
      expect(html, p.id).toContain(`±${(p.legs[0].bandPct * 100).toFixed(0)}% × ${p.legs[0].gridCount}`);
    }
  });

  it('documents the trend bot from the code constants and never names the key variable', () => {
    expect(html).toContain('EMA cross');
    expect(html).toContain('Donchian breakout');
    expect(html).toMatch(/Cost check/);
    expect(/PRIVATE_KEY|privateKey/.test(html)).toBe(false);
  });

  it('is wired into the main UI behind a Guide button', () => {
    const app = readFileSync(join(__dirname, '..', 'src', 'App.tsx'), 'utf8');
    expect(app).toMatch(/onClick=\{\(\) => setGuide\(true\)\}>Guide</);
    expect(app).toContain('<Guide onClose={closeGuide} />');
  });

  it('documents the supported chains, PulseChain DEXes and the custom-token policy', () => {
    for (const c of CHAINS) expect(html, c.name).toContain(c.name);
    for (const x of ['PulseX V1 (V2, 0.29%)', 'PulseX V2 (V2, 0.29%)', '9mm V2 (V2, 0.25%)', '9mm V3 (V3', 'paper-only', 'Auto: best quote']) expect(html, x).toContain(x);
  });
});
