/**
 * Coin logos (the Wallet, the token trader's cards), found once and kept in data/logos so they are never asked again.
 * PulseChain's come from DexScreener (Kyle, 2026-10-31), each other chain's from GeckoTerminal (a token's image_url,
 * through the app's paced GeckoTerminal client). Images are downloaded from that source's own image servers only. Coins
 * asked for together (a page of cards) are looked up in one call of up to 30 (2026-10-30: one GeckoTerminal call per
 * coin, queued behind the scan and the candle history, left a page of cards on letter marks for minutes). A coin with
 * no logo is remembered for a day before asking again. Native coins have no address and keep the app's own marks.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FetchJson } from '../fetchJson';

/** Raster types only: an SVG could carry script */
const TYPES: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' };
const MAX_BYTES = 256 * 1024;
const MISS_MS = 86_400_000;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
/** Coins asked for within this long share one call */
export const BATCH_MS = 150;
/** Both sources take up to 30 addresses a call */
const BATCH_MAX = 30;

/** Where a chain's logos come from: DexScreener's chain id, or GeckoTerminal's network */
export type LogoSource = { from: 'dexscreener'; chain: string } | { from: 'geckoterminal'; network: string };

/** Each source: the call for a batch of addresses, each coin's image url in its answer, and the image servers it uses */
const SOURCES = {
  dexscreener: {
    url: (s: LogoSource, a: string[]) => `https://api.dexscreener.com/tokens/v1/${(s as { chain: string }).chain}/${a.join(',')}`,
    /** pairs: a coin's image is on a pair where it is the base token */
    images: (j: unknown) => {
      const out = new Map<string, string>();
      for (const p of (Array.isArray(j) ? j : []) as { baseToken?: { address?: string }; info?: { imageUrl?: string } }[]) {
        const a = String(p.baseToken?.address ?? '').toLowerCase();
        if (a && p.info?.imageUrl && !out.has(a)) out.set(a, p.info.imageUrl);
      }
      return out;
    },
    /** DexScreener serves 800 px (~200 KB); a card shows 34 px */
    image: (src: string) => { const u = new URL(src); u.searchParams.set('width', '128'); u.searchParams.set('height', '128'); return u; },
    hosts: new Set(['cdn.dexscreener.com']),
    name: "DexScreener's image server",
  },
  geckoterminal: {
    url: (s: LogoSource, a: string[]) => `https://api.geckoterminal.com/api/v2/networks/${(s as { network: string }).network}/tokens/multi/${a.join(',')}`,
    images: (j: unknown) => {
      const out = new Map<string, string>();
      for (const t of ((j as { data?: { attributes?: { address?: string; image_url?: string | null } }[] }).data ?? [])) {
        // GeckoTerminal answers "missing.png" for a token it has no image for
        const a = String(t.attributes?.address ?? '').toLowerCase(), src = t.attributes?.image_url;
        if (a && src && /^https:/.test(src)) out.set(a, src);
      }
      return out;
    },
    image: (src: string) => new URL(src),
    hosts: new Set(['coin-images.coingecko.com', 'assets.coingecko.com']),
    name: "CoinGecko's image servers",
  },
};

export type FetchBytes = (url: string) => Promise<{ type: string; bytes: Buffer }>;
export const fetchBytes: FetchBytes = async (url) => {
  const r = await fetch(url, { headers: { 'user-agent': 'GridBot' }, signal: AbortSignal.timeout(20_000) });
  if (!r.ok) throw new Error(`HTTP ${r.status} from ${new URL(url).host}`);
  return { type: (r.headers.get('content-type') ?? '').split(';')[0].trim(), bytes: Buffer.from(await r.arrayBuffer()) };
};

export interface Logo { type: string; bytes: Buffer }
interface Ask { address: string; done: (src: string | null) => void; fail: (e: unknown) => void }

export class Logos {
  private misses = new Map<string, number>();
  private flights = new Map<string, Promise<Logo | null>>();
  private asks = new Map<string, { source: LogoSource; q: Ask[] }>();
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  constructor(
    private readonly dir: string,
    private readonly sourceOf: (chainId: number) => LogoSource | null,
    /** JSON from each source: GeckoTerminal's goes through the app's paced client */
    private readonly fetchJson: Record<LogoSource['from'], FetchJson>,
    private readonly getBytes: FetchBytes = fetchBytes,
    private readonly now: () => number = Date.now,
  ) {}

  /** The coin's logo, or null when its source has none (asked again after a day) */
  get(chainId: number, address: string): Promise<Logo | null> {
    if (!ADDRESS.test(address)) throw new Error(`not a coin address: ${address}`);
    const source = this.sourceOf(chainId);
    if (!source) throw new Error(`no logo source for chain ${chainId}`);
    const key = `${chainId}-${address.toLowerCase()}`;
    const kept = this.read(key);
    if (kept) return Promise.resolve(kept);
    const missed = this.misses.get(key);
    if (missed != null && this.now() - missed < MISS_MS) return Promise.resolve(null);
    const running = this.flights.get(key);
    if (running) return running;
    const run = this.find(source, address, key).finally(() => this.flights.delete(key));
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

  /** The coin's image url at its source (null: none), looked up with that chain's other coins asked for meanwhile */
  private imageUrl(source: LogoSource, address: string): Promise<string | null> {
    const id = JSON.stringify(source);
    return new Promise((done, fail) => {
      const b = this.asks.get(id) ?? { source, q: [] };
      b.q.push({ address, done, fail });
      this.asks.set(id, b);
      if (b.q.length >= BATCH_MAX) this.flush(id);
      else if (!this.timers.has(id)) this.timers.set(id, setTimeout(() => this.flush(id), BATCH_MS));
    });
  }

  private flush(id: string) {
    clearTimeout(this.timers.get(id));
    this.timers.delete(id);
    const b = this.asks.get(id);
    this.asks.delete(id);
    if (!b?.q.length) return;
    const { source, q } = b, s = SOURCES[source.from];
    this.fetchJson[source.from](s.url(source, q.map((x) => x.address))).then((j) => {
      const images = s.images(j);
      for (const x of q) x.done(images.get(x.address.toLowerCase()) ?? null);
    }, (e: unknown) => { for (const x of q) x.fail(e); });
  }

  private async find(source: LogoSource, address: string, key: string): Promise<Logo | null> {
    const src = await this.imageUrl(source, address);
    if (!src) { this.misses.set(key, this.now()); return null; }
    const s = SOURCES[source.from], url = s.image(src);
    if (!s.hosts.has(url.host)) throw new Error(`logo for ${address} is not on ${s.name}: ${url.host}`);
    const got = await this.getBytes(url.toString());
    const ext = TYPES[got.type];
    if (!ext) throw new Error(`logo for ${address} is ${got.type || 'untyped'}, not a png, jpeg, webp or gif`);
    if (got.bytes.length > MAX_BYTES) throw new Error(`logo for ${address} is ${got.bytes.length} bytes (max ${MAX_BYTES})`);
    mkdirSync(this.dir, { recursive: true });
    writeFileSync(join(this.dir, `${key}.${ext}`), got.bytes);
    return { type: got.type, bytes: got.bytes };
  }
}

/** A chain's logo source: PulseChain → DexScreener (Kyle, 2026-10-31), every other chain → GeckoTerminal */
export function logoSource(chain: { id: number; screener?: string; geckoSlug: string | null } | null): LogoSource | null {
  if (!chain) return null;
  if (chain.id === 369) return chain.screener ? { from: 'dexscreener', chain: chain.screener } : null;
  return chain.geckoSlug ? { from: 'geckoterminal', network: chain.geckoSlug } : null;
}
