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
import { Logos, logoSource } from '../src/server/holdings/logos';
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
  const pair = (address: string, imageUrl: string | null) => ({ baseToken: { address }, ...(imageUrl ? { info: { imageUrl } } : {}) });
  const gecko = (address: string, image_url: string | null) => ({ data: [{ attributes: { address: address.toLowerCase(), image_url } }] });
  const sourceOf = (id: number) => logoSource(id === 369 ? { id, screener: 'pulsechain', geckoSlug: 'pulsechain' } : id === 1 ? { id, geckoSlug: 'eth' } : null);
  const rig = (answer: unknown, bytes: { type: string; bytes: Buffer } = { type: 'image/png', bytes: png }) => {
    const dir = mkdtempSync(join(tmpdir(), 'logos-')), asked: string[] = [], got: string[] = [];
    const json = async (u: string) => { asked.push(u); return answer; };
    const logos = new Logos(dir, sourceOf, { dexscreener: json, geckoterminal: json }, async (u) => { got.push(u); return bytes; });
    return { dir, logos, asked, got };
  };
  const CDN = 'https://cdn.dexscreener.com/cms/images/84a9?width=800&height=800&quality=95&format=auto';

  it('PulseChain: found on DexScreener, downloaded at 128 px from its image server, kept on disk', async () => {
    const r = rig([pair(HEX, CDN)]);
    expect((await r.logos.get(369, HEX))?.type).toBe('image/png');
    expect(r.asked).toEqual([`https://api.dexscreener.com/tokens/v1/pulsechain/${HEX}`]);
    expect(r.got).toEqual(['https://cdn.dexscreener.com/cms/images/84a9?width=128&height=128&quality=95&format=auto']);
    expect(readdirSync(r.dir)).toEqual([`369-${HEX.toLowerCase()}.png`]);
    await r.logos.get(369, HEX);
    expect(r.asked).toHaveLength(1);
  });

  it('other chains: found on GeckoTerminal, downloaded from CoinGecko', async () => {
    const r = rig(gecko(HEX, 'https://coin-images.coingecko.com/coins/images/10103/large/HEX-logo.png?1696510130'));
    expect((await r.logos.get(1, HEX))?.type).toBe('image/png');
    expect(r.asked).toEqual([`https://api.geckoterminal.com/api/v2/networks/eth/tokens/multi/${HEX}`]);
    expect(r.got).toEqual(['https://coin-images.coingecko.com/coins/images/10103/large/HEX-logo.png?1696510130']);
  });

  it('coins asked for together are looked up in one call (a page of cards asks for all its coins at once)', async () => {
    const A = '0x' + 'a1'.repeat(20), B = '0x' + 'b2'.repeat(20);
    const r = rig([HEX, A, B].map((x) => pair(x, CDN)));
    const got = await Promise.all([HEX, A, B].map((x) => r.logos.get(369, x)));
    expect(got.every((x) => x?.type === 'image/png')).toBe(true);
    expect(r.asked).toEqual([`https://api.dexscreener.com/tokens/v1/pulsechain/${HEX},${A},${B}`]);
    expect(r.got).toHaveLength(3);
  });

  it('a coin with no logo is remembered for a day (DexScreener: no image; GeckoTerminal: "missing.png")', async () => {
    const d = rig([pair(HEX, null)]);
    expect(await d.logos.get(369, HEX)).toBeNull();
    expect(await d.logos.get(369, HEX)).toBeNull();
    expect(d.asked).toHaveLength(1);
    expect(await rig(gecko(HEX, 'missing.png')).logos.get(1, HEX)).toBeNull();
  });

  it('refuses an image off the source\'s server, an SVG, an oversized file, a bad address and an unknown chain', async () => {
    await expect(rig([pair(HEX, 'https://evil.example/x.png')]).logos.get(369, HEX)).rejects.toThrow(/not on DexScreener's image server: evil\.example/);
    await expect(rig(gecko(HEX, 'https://evil.example/x.png')).logos.get(1, HEX)).rejects.toThrow(/not on CoinGecko's image servers: evil\.example/);
    await expect(rig([pair(HEX, CDN)], { type: 'image/svg+xml', bytes: png }).logos.get(369, HEX)).rejects.toThrow(/image\/svg\+xml, not a png/);
    const big = rig([pair(HEX, CDN)], { type: 'image/png', bytes: Buffer.alloc(300 * 1024) });
    await expect(big.logos.get(369, HEX)).rejects.toThrow(/bytes \(max/);
    expect(existsSync(join(big.dir, `369-${HEX.toLowerCase()}.png`))).toBe(false);
    expect(() => rig([]).logos.get(369, '0x12')).toThrow(/not a coin address/);
    expect(() => rig([]).logos.get(56, HEX)).toThrow(/no logo source for chain 56/);
  });
});
