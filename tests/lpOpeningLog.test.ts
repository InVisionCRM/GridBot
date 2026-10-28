/**
 * The LP's "opening" log line names the range, the price and the mode, not the amount (Kyle: the Invested tile shows it
 * once on the page); the "opened … with X + Y" line after the mint keeps what actually went in.
 */
import { describe, expect, it } from 'vitest';
import { NETWORKS } from '../src/live/networks';
import { chainFromNetwork } from '../src/live/chains';
import { legacyMarkets, type MarketDef } from '../src/live/markets';
import { ChainRuntime } from '../src/server/chains/runtime';
import { Hub } from '../src/server/chains/hub';
import { MemoryStore } from '../src/server/bot/store';
import { Logger } from '../src/server/bot/logger';
import { LpEngine, type LpState } from '../src/server/bot/lpEngine';
import { MultiDexMock, type Tok } from './helpers/multiDex';

const NET = NETWORKS.mainnet;
const CH = chainFromNetwork(NET);
const dex = (id: string) => CH.dexes.find((d) => d.id === id)!;
const WPLS: Tok = { address: NET.pulsex.wpls, symbol: 'WPLS', decimals: 18 };
const DAI: Tok = { address: NET.quotes.find((q) => q.symbol === 'DAI')!.address, symbol: 'DAI', decimals: 18 };

describe('LP log: the opening line carries no amount', () => {
  it('opening ±10% around <price> (paper), then opened <range> with <base> + <quote>', async () => {
    const m = new MultiDexMock();
    [WPLS, DAI].forEach((t) => m.addToken(t));
    m.addV3('9mm-v3', { factory: dex('9mm-v3').factory, quoter: dex('9mm-v3').quoter! });
    const pool = m.v3Pool('9mm-v3', WPLS, 1e10, DAI, 3e5, 2500);
    const def: MarketDef = {
      key: 'pulsechain:PLS/DAI#9mm', chainId: 369, custom: true,
      base: { address: WPLS.address, symbol: 'PLS', decimals: 18, native: true }, quote: { address: DAI.address, symbol: 'DAI', decimals: 18 },
      pool: { dex: '9mm-v3', kind: 'v3', address: pool, feeBps: 25, feeTier: 2500 }, probe: 1, quoteKind: 'stable',
    };
    const hub = new Hub({ runtimes: [new ChainRuntime(CH, m, null)], markets: [...legacyMarkets(NET), def], legacyNet: NET });
    const msgs: string[] = [];
    const lp = new LpEngine({ net: NET, store: new MemoryStore<LpState>(), log: new Logger(true), hub, now: () => 1_800_000_000_000, emit: (e) => { msgs.push(e.msg); } });
    await lp.start({ mode: 'paper', market: 'pulsechain:PLS/DAI#9mm', bandPct: 0.1, capital: 1000 });
    await lp.tick();
    const opening = msgs.find((x) => /: opening /.test(x));
    expect(opening).toMatch(/: opening ±10% around [\d.e-]+ \(paper\)$/);
    expect(opening!.slice(opening!.indexOf(': opening '))).not.toMatch(/1000|DAI|PLS|with/);
    expect(msgs.find((x) => /: opened /.test(x))).toMatch(/: opened [\d.e-]+–[\d.e-]+ with [\d.e+-]+ PLS \+ [\d.e+-]+ DAI$/);
  });
});
