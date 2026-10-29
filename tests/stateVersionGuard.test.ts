/**
 * Audit b007: a state file whose version or shape this build does not know must stop the start with an error that
 * names it, and must never be overwritten with an empty state (which would erase every bot, live ones included).
 */
import { describe, expect, it } from 'vitest';
import { Logger } from '../src/server/bot/logger';
import { MultiBot, type MultiState } from '../src/server/bot/multi';
import { MemoryStore } from '../src/server/bot/store';
import { MockChain, NET } from './helpers/mockChain';

const make = (data: unknown) => {
  const store = new MemoryStore<MultiState>();
  store.data = data as MultiState;
  const chain = new MockChain(1e-5);
  const build = () => new MultiBot({ net: NET, reader: chain, signer: null, store, log: new Logger(true) });
  return { store, build };
};

describe('state file of an unknown version or shape', () => {
  it('a newer version: the start fails naming it, and the file is left as it was', () => {
    const file = { version: 5, grids: [{ id: 'g-live', mode: 'live' }], trends: [], lps: [] };
    const w = make(file);
    expect(w.build).toThrow(/version 5/);
    expect(w.store.data).toEqual(file);
  });
  it('a v4 file without a grids array: refused too', () => {
    const file = { version: 4, trends: [{ id: 't1' }] };
    const w = make(file);
    expect(w.build).toThrow(/version 4/);
    expect(w.store.data).toEqual(file);
  });
  it('no file yet: starts empty', () => {
    const w = make(null);
    expect(w.build().status().grids).toEqual([]);
  });
});
