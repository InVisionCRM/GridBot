/**
 * The Wallet drawer's server side: the dollar value over time (a point at most every 15 min, from real holdings reads
 * only) and coin logos (found once on GeckoTerminal, from CoinGecko's image servers only, raster only, kept on disk).
 */
import { existsSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MemoryStore } from '../src/server/bot/store';
import { WalletHistory, WORTH_EVERY_MS, WORTH_SHOWN, type WorthFile } from '../src/server/holdings/history';
import { Logos } from '../src/server/holdings/logos';
import type { HoldingsSnapshot } from '../src/live/holdingsMath';
import { HOLDINGS } from './helpers/unitsScreens';

const T0 = 1_793_000_000_000;
const snap = (at: number, usd: number | null, hasSigner = true): HoldingsSnapshot =>
  ({ ...(HOLDINGS as HoldingsSnapshot), at, hasSigner, netWorthExDustUsd: usd });

describe('wallet value over time', () => {
  it('keeps a point at most every 15 minutes, with each chain\'s part, and saves it', () => {
    const store = new MemoryStore<WorthFile>();
    const h = new WalletHistory(store, () => T0 + 3 * WORTH_EVERY_MS);
    expect(h.note(snap(T0, 4774.69))).toBe(true);
    expect(h.note(snap(T0 + WORTH_EVERY_MS - 1, 4800))).toBe(false);
    expect(h.note(snap(T0 + WORTH_EVERY_MS, 4810))).toBe(true);
    const pts = h.series('1D', null);
    expect(pts).toEqual([{ t: T0, usd: 4774.69 }, { t: T0 + WORTH_EVERY_MS, usd: 4810 }]);
    const pls = HOLDINGS.chains.find((c: { chainId: number }) => c.chainId === 369).usd;
    expect(h.series('1D', 369).map((p) => p.usd)).toEqual([pls, pls]);
    expect(new WalletHistory(store).series('ALL', null)).toHaveLength(2);
  });

  it('records nothing without a wallet key or a total', () => {
    const h = new WalletHistory(new MemoryStore<WorthFile>());
    expect(h.note(snap(T0, 100, false))).toBe(false);
    expect(h.note(snap(T0, null))).toBe(false);
    expect(h.series('ALL', null)).toEqual([]);
  });

  it('a range shows its own window, thinned to a chart\'s worth with the latest point kept', () => {
    const store = new MemoryStore<WorthFile>();
    const n = 2 * 24 * 4 * 30; // 60 days of 15-minute points
    store.save({ version: 1, points: Array.from({ length: n }, (_, i) => ({ t: T0 + i * WORTH_EVERY_MS, usd: i, chains: {} })) });
    const now = T0 + (n - 1) * WORTH_EVERY_MS, h = new WalletHistory(store, () => now);
    const day = h.series('1D', null);
    expect(day.length).toBe(97);
    expect(day[0].t).toBe(now - 86_400_000);
    const all = h.series('ALL', null);
    expect(all).toHaveLength(WORTH_SHOWN);
    expect(all[all.length - 1]).toEqual({ t: now, usd: n - 1 });
  });

  it('refuses a file from another version', () => {
    const store = new MemoryStore<WorthFile>();
    store.save({ version: 2, points: [] } as unknown as WorthFile);
    expect(() => new WalletHistory(store)).toThrow(/unknown version 2/);
  });
});

describe('coin logos', () => {
  const HEX = '0x2b591e99afE9f32eAA6214f7B7629768c40Eeb39';
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
  const token = (image_url: string | null) => ({ data: { attributes: { image_url } } });
  const rig = (answer: unknown, bytes: { type: string; bytes: Buffer } = { type: 'image/png', bytes: png }) => {
    const dir = mkdtempSync(join(tmpdir(), 'logos-')), asked: string[] = [], got: string[] = [];
    const logos = new Logos(dir, (id) => (id === 369 ? 'pulsechain' : null), async (u) => { asked.push(u); return answer; }, async (u) => { got.push(u); return bytes; });
    return { dir, logos, asked, got };
  };

  it('finds the logo once on GeckoTerminal, downloads it from CoinGecko, and keeps it on disk', async () => {
    const r = rig(token('https://coin-images.coingecko.com/coins/images/10103/large/HEX-logo.png?1696510130'));
    const a = await r.logos.get(369, HEX);
    expect(a?.type).toBe('image/png');
    expect(r.asked).toEqual([`https://api.geckoterminal.com/api/v2/networks/pulsechain/tokens/${HEX}`]);
    expect(r.got).toEqual(['https://coin-images.coingecko.com/coins/images/10103/large/HEX-logo.png?1696510130']);
    expect(readdirSync(r.dir)).toEqual([`369-${HEX.toLowerCase()}.png`]);
    await r.logos.get(369, HEX);
    expect(r.asked).toHaveLength(1);
  });

  it('a coin without a logo ("missing.png") is remembered for a day', async () => {
    const r = rig(token('missing.png'));
    expect(await r.logos.get(369, HEX)).toBeNull();
    expect(await r.logos.get(369, HEX)).toBeNull();
    expect(r.asked).toHaveLength(1);
  });

  it('refuses an image off the CDN, an SVG, an oversized file, a bad address and an unknown chain', async () => {
    await expect(rig(token('https://evil.example/x.png')).logos.get(369, HEX)).rejects.toThrow(/not on CoinGecko's image servers: evil\.example/);
    await expect(rig(token('https://coin-images.coingecko.com/x'), { type: 'image/svg+xml', bytes: png }).logos.get(369, HEX)).rejects.toThrow(/image\/svg\+xml, not a png/);
    const big = rig(token('https://coin-images.coingecko.com/x'), { type: 'image/png', bytes: Buffer.alloc(300 * 1024) });
    await expect(big.logos.get(369, HEX)).rejects.toThrow(/bytes \(max/);
    expect(existsSync(join(big.dir, `369-${HEX.toLowerCase()}.png`))).toBe(false);
    expect(() => rig(token(null)).logos.get(369, '0x12')).toThrow(/not a coin address/);
    expect(() => rig(token(null)).logos.get(1, HEX)).toThrow(/no GeckoTerminal network for 1/);
  });
});
