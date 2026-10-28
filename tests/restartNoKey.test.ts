/**
 * Restart with a running LIVE grid saved in state.json but no signing key for its chain (the key was removed, or the
 * app was started from another folder so .env wasn't found). The app must still start: that grid loads stopped with
 * the reason recorded, and every other bot carries on. It used to throw in the constructor and crash the app at boot.
 */
import { describe, expect, it } from 'vitest';
import { MultiBot, type MultiState } from '../src/server/bot/multi';
import { MemoryStore } from '../src/server/bot/store';
import { Logger } from '../src/server/bot/logger';
import { MockChain, NET } from './helpers/mockChain';

type Row = { id: string; status: string; halt: { what: string; detail: string; origin: string } | null; lastError: string | null };

describe('restart: a saved live grid without a key', () => {
  it('loads stopped with a startup halt; paper bots keep running; resume says why', async () => {
    const chain = new MockChain();
    const store = new MemoryStore<MultiState>();
    const a = new MultiBot({ net: NET, reader: chain, signer: chain, store, log: new Logger(true) });
    const spot = (await a.prices())[NET.defaultQuote];
    const grid = { stable: NET.defaultQuote, lowerPrice: spot * 0.8, upperPrice: spot * 1.2, gridCount: 4, totalCapitalQuote: 10 };
    const live = await a.add({ mode: 'live', ...grid });
    const paper = await a.add({ mode: 'paper', ...grid });

    let b!: MultiBot;
    expect(() => { b = new MultiBot({ net: NET, reader: chain, signer: null, store, log: new Logger(true) }); }).not.toThrow();
    const rows = b.status().grids as Row[];
    const l = rows.find((g) => g.id === live)!, p = rows.find((g) => g.id === paper)!;
    expect(l.status).toBe('stopped');
    expect(l.halt).toMatchObject({ what: 'startup', origin: 'system' });
    expect(l.halt!.detail).toMatch(/No signing key/);
    expect(l.lastError).toMatch(/PRIVATE_KEY|key/);
    expect(p.status).toBe('running');
    expect(() => b.resume(live)).toThrow(/PRIVATE_KEY|key/);
  });
});
