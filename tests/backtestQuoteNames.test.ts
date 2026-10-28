/** The harness reads data/state.json; since the *Usd → *Quote rename (state v7) saves carry the new names. Both load the same. */
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadAppState, recordedQuoteNet } from '../src/backtest/state';
import { upgradeQuoteNames } from '../src/live/ledger';

describe('backtest harness: saved state with the quote-coin names', () => {
  it('a v7 save (totalCapitalQuote, realizedPnlQuote) replays the same bots and recorded net as the old names', () => {
    const fixture = join(__dirname, 'fixtures', 'state.json');
    const raw = JSON.parse(readFileSync(fixture, 'utf8'));
    const renamed = { ...raw, grids: (raw.grids ?? []).map((g: object) => upgradeQuoteNames(g as never)) };
    expect(JSON.stringify(renamed.grids)).not.toMatch(/totalCapitalUsd|realizedPnlUsd/);
    const file = join(mkdtempSync(join(tmpdir(), 'bt-names-')), 'state.json');
    writeFileSync(file, JSON.stringify(renamed));
    const a = loadAppState(fixture), b = loadAppState(file);
    expect(b.bots.map((x) => x.id)).toEqual(a.bots.map((x) => x.id));
    for (let i = 0; i < a.bots.length; i++) {
      expect(b.bots[i].config).toEqual(a.bots[i].config);
      expect(recordedQuoteNet(b.bots[i])).toEqual(recordedQuoteNet(a.bots[i]));
    }
  });
});
