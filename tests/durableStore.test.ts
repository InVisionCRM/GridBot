import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DurableJsonStore } from '../src/server/bot/durableStore';
import { JsonStore } from '../src/server/bot/store';
import { multiUrgentKey, MultiBot, type MultiState } from '../src/server/bot/multi';
import { Logger } from '../src/server/bot/logger';
import { MockChain, NET } from './helpers/mockChain';

type S = { n: number; tx: string | null };
const dir = () => mkdtempSync(join(tmpdir(), 'durable-'));
const read = (f: string) => JSON.parse(readFileSync(f, 'utf8'));

describe('DurableJsonStore (state.json)', () => {
  it('coalesces routine saves into one write, serialized at write time', async () => {
    const f = join(dir(), 'state.json');
    const st = new DurableJsonStore<S>(f, { delayMs: 20, urgentKey: (s) => String(s.tx) });
    st.save({ n: 0, tx: null }); // first save: the key is new, so it is written now
    expect(st.writes).toBe(1);
    const live = { n: 1, tx: null };
    for (let i = 0; i < 100; i++) { live.n = i; st.save(live); }
    expect(st.writes).toBe(1); // nothing written synchronously
    await st.idle();
    expect(st.writes).toBe(2);
    expect(read(f)).toEqual({ n: 99, tx: null });
  });

  it('a change in the urgent key is on disk before save() returns (a tx marked in flight before it is sent)', async () => {
    const f = join(dir(), 'state.json');
    const st = new DurableJsonStore<S>(f, { delayMs: 10_000, urgentKey: (s) => String(s.tx) });
    st.save({ n: 1, tx: null });
    st.save({ n: 2, tx: null }); // routine, waits
    expect(read(f)).toEqual({ n: 1, tx: null });
    st.save({ n: 3, tx: '0xabc' });
    expect(read(f)).toEqual({ n: 3, tx: '0xabc' });
    await st.idle();
  });

  it('a slower debounced write never overwrites a newer urgent one', async () => {
    const f = join(dir(), 'state.json');
    const st = new DurableJsonStore<S>(f, { delayMs: 0, urgentKey: (s) => String(s.tx) });
    st.save({ n: 1, tx: null });
    st.save({ n: 2, tx: null });
    await new Promise((r) => setTimeout(r, 1)); // the debounced write has started
    st.save({ n: 3, tx: '0x1' }); // urgent, synchronous
    await st.idle();
    expect(read(f)).toEqual({ n: 3, tx: '0x1' });
  });

  it('keeps the previous file as .bak and loads it when the file is corrupt or missing', async () => {
    const d = dir(), f = join(d, 'state.json');
    const st = new DurableJsonStore<S>(f, { urgentKey: (s) => String(s.n) });
    st.save({ n: 1, tx: null });
    st.save({ n: 2, tx: null });
    expect(read(`${f}.bak`)).toEqual({ n: 1, tx: null });
    writeFileSync(f, '{"n": 2, "tx": nu'); // torn write
    const errs: string[] = [];
    const again = new DurableJsonStore<S>(f, { onError: (e) => errs.push(e.message) });
    expect(again.load()).toEqual({ n: 1, tx: null });
    expect(errs[0]).toMatch(/unreadable.*loaded the backup/);
    expect(new DurableJsonStore<S>(join(d, 'none.json')).load()).toBeNull();
  });

  it('flush() writes what is pending, synchronously (shutdown)', () => {
    const f = join(dir(), 'state.json');
    const st = new DurableJsonStore<S>(f, { delayMs: 60_000, urgentKey: () => 'same' });
    st.save({ n: 1, tx: null });
    st.save({ n: 2, tx: null });
    st.flush();
    expect(read(f)).toEqual({ n: 2, tx: null });
    expect(existsSync(`${f}.tmp`)).toBe(false);
  });

  it('JsonStore (other files) also keeps a .bak and falls back to it', () => {
    const f = join(dir(), 'x.json');
    const s = new JsonStore<S>(f);
    s.save({ n: 1, tx: null });
    s.save({ n: 2, tx: null });
    writeFileSync(f, 'garbage');
    expect(s.load()).toEqual({ n: 1, tx: null });
  });

  it("MultiBot: a tick's price updates are debounced, a stop is written at once", async () => {
    const f = join(dir(), 'state.json');
    const store = new DurableJsonStore<MultiState>(f, { delayMs: 60_000, urgentKey: multiUrgentKey });
    const chain = new MockChain(1e-5);
    const bot = new MultiBot({ net: NET, reader: chain, signer: null, store, log: new Logger(true) });
    const id = await bot.add({ mode: 'paper', stable: 'DAI', lowerPrice: 0.9e-5, upperPrice: 1.1e-5, gridCount: 10, totalCapitalUsd: 30 });
    expect(read(f).grids[0].status).toBe('running');
    await bot.tickAll(); // the seed buy: a fill, written at once
    const w = store.writes;
    await bot.tickAll();
    await bot.tickAll();
    expect(store.writes).toBe(w); // price ticks: pending, not written
    bot.stop(id);
    expect(read(f).grids[0].status).toBe('stopped');
    expect(read(f).grids[0].halt).toBeTruthy();
    bot.flush();
  });
});
