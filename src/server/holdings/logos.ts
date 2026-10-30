/**
 * Coin logos for the Wallet. Found once on GeckoTerminal (a token's image_url), through the app's paced GeckoTerminal
 * client, downloaded from CoinGecko's image servers only, and kept in data/logos so it is never asked again. A coin
 * with no logo there is remembered for a day before asking again. Native coins have no address and keep the app's own
 * marks. (DexScreener had none for USDG, Robinhood WETH or USDC on 2026-10-30; GeckoTerminal had all three.)
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FetchJson } from '../fetchJson';

const API = 'https://api.geckoterminal.com/api/v2/networks';
/** Images come from CoinGecko's image servers and nowhere else */
const CDN = new Set(['coin-images.coingecko.com', 'assets.coingecko.com']);
/** Raster types only: an SVG could carry script */
const TYPES: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' };
const MAX_BYTES = 256 * 1024;
const MISS_MS = 86_400_000;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

export type FetchBytes = (url: string) => Promise<{ type: string; bytes: Buffer }>;
export const fetchBytes: FetchBytes = async (url) => {
  const r = await fetch(url, { headers: { 'user-agent': 'GridBot' }, signal: AbortSignal.timeout(20_000) });
  if (!r.ok) throw new Error(`HTTP ${r.status} from ${new URL(url).host}`);
  return { type: (r.headers.get('content-type') ?? '').split(';')[0].trim(), bytes: Buffer.from(await r.arrayBuffer()) };
};

export interface Logo { type: string; bytes: Buffer }

export class Logos {
  private misses = new Map<string, number>();
  private flights = new Map<string, Promise<Logo | null>>();
  constructor(
    private readonly dir: string,
    private readonly slugOf: (chainId: number) => string | null,
    private readonly fetchJson: FetchJson,
    private readonly getBytes: FetchBytes = fetchBytes,
    private readonly now: () => number = Date.now,
  ) {}

  /** The coin's logo, or null when GeckoTerminal has none (asked again after a day) */
  get(chainId: number, address: string): Promise<Logo | null> {
    if (!ADDRESS.test(address)) throw new Error(`not a coin address: ${address}`);
    const slug = this.slugOf(chainId);
    if (!slug) throw new Error(`no GeckoTerminal network for ${chainId}`);
    const key = `${chainId}-${address.toLowerCase()}`;
    const kept = this.read(key);
    if (kept) return Promise.resolve(kept);
    const missed = this.misses.get(key);
    if (missed != null && this.now() - missed < MISS_MS) return Promise.resolve(null);
    const running = this.flights.get(key);
    if (running) return running;
    const run = this.find(slug, address, key).finally(() => this.flights.delete(key));
    this.flights.set(key, run);
    return run;
  }

  private read(key: string): Logo | null {
    for (const [type, ext] of Object.entries(TYPES)) {
      const f = join(this.dir, `${key}.${ext}`);
      if (existsSync(f)) return { type, bytes: readFileSync(f) };
    }
    return null;
  }

  private async find(slug: string, address: string, key: string): Promise<Logo | null> {
    const j = (await this.fetchJson(`${API}/${slug}/tokens/${address}`)) as { data?: { attributes?: { image_url?: string | null } } };
    const src = j.data?.attributes?.image_url;
    // GeckoTerminal answers "missing.png" for a token it has no image for
    if (!src || !/^https:/.test(src)) { this.misses.set(key, this.now()); return null; }
    const url = new URL(src);
    if (!CDN.has(url.host)) throw new Error(`logo for ${address} is not on CoinGecko's image servers: ${url.host}`);
    const got = await this.getBytes(url.toString());
    const ext = TYPES[got.type];
    if (!ext) throw new Error(`logo for ${address} is ${got.type || 'untyped'}, not a png, jpeg, webp or gif`);
    if (got.bytes.length > MAX_BYTES) throw new Error(`logo for ${address} is ${got.bytes.length} bytes (max ${MAX_BYTES})`);
    mkdirSync(this.dir, { recursive: true });
    writeFileSync(join(this.dir, `${key}.${ext}`), got.bytes);
    return { type: got.type, bytes: got.bytes };
  }
}
