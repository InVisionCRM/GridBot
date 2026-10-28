/**
 * The chain's RPC reader under rate limits: a single-RPC chain (Robinhood) waits out a 429 for seconds instead of giving
 * up after 1.2 s; everything else retries as before.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { JsonRpcProvider } from 'ethers';
import { FallbackReader } from '../src/server/chains/fallback';

/** The error ethers throws on a 429 (from a live ETH/USDG liquidity bot on Robinhood, 2026-10-22) */
const tooMany = () => Object.assign(new Error('exceeded maximum retry limit (request={  }, response={  }, error=null, info={ "requestUrl": "https://rpc.mainnet.chain.robinhood.com", "responseBody": "{\\"jsonrpc\\":\\"2.0\\",\\"error\\":{\\"code\\":429,\\"message\\":\\"Too Many Requests\\"}}\\n", "responseStatus": "599 CLIENT ESCALATED SERVER ERROR (429 Too Many Requests; exceeded maximum retry limit)" }, code=SERVER_ERROR, version=6.17.0)'), { code: 'SERVER_ERROR' });
const down = () => Object.assign(new Error('connect ECONNREFUSED'), { code: 'NETWORK_ERROR' });

/** An RPC answering each call from a script; records when it was asked */
function rpc(script: ('429' | 'down' | 'ok')[]) {
  const at: number[] = [];
  const p = { call: async () => { at.push(Date.now()); const s = script.shift() ?? 'ok'; if (s === '429') throw tooMany(); if (s === 'down') throw down(); return '0x01'; } };
  return { p: p as unknown as JsonRpcProvider, at };
}
async function settle<T>(p: Promise<T>) {
  const out = p.then((v) => ({ v }), (e: Error) => ({ e: e.message }));
  await vi.advanceTimersByTimeAsync(60_000);
  return out;
}
const T0 = 1_800_000_000_000;
const tx = { to: '0x52e65B17fB6E5BA00Ed806f37Afcd2DaA50271Ca', data: '0x3850c7bd' };

describe('FallbackReader: rate limits', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(T0); });
  afterEach(() => { vi.useRealTimers(); });

  it('one RPC: a 429 is waited out 1 s, 2 s, then 4 s (it lasted over 1.2 s under load)', async () => {
    const a = rpc(['429', '429', '429', 'ok']);
    const r = new FallbackReader(['https://rpc.mainnet.chain.robinhood.com'], 4663, [a.p]);
    expect(await settle(r.call(tx))).toEqual({ v: '0x01' });
    expect(a.at.map((t) => t - T0)).toEqual([0, 1000, 3000, 7000]);
  });

  it('one RPC: still refused after 7 s, the 429 is the error', async () => {
    const a = rpc(['429', '429', '429', '429', 'ok']);
    const r = new FallbackReader(['https://rpc.mainnet.chain.robinhood.com'], 4663, [a.p]);
    expect(await settle(r.call(tx))).toMatchObject({ e: expect.stringMatching(/429 Too Many Requests/) });
    expect(a.at).toHaveLength(4);
  });

  it('one RPC, not a rate limit (node down): three tries, 0.4 s and 0.8 s apart, as before', async () => {
    const a = rpc(['down', 'down', 'ok']);
    const r = new FallbackReader(['https://rpc.mainnet.chain.robinhood.com'], 4663, [a.p]);
    expect(await settle(r.call(tx))).toEqual({ v: '0x01' });
    expect(a.at.map((t) => t - T0)).toEqual([0, 400, 1200]);
  });

  it('one RPC: a 429 then a node error: the 429 waits 1 s, the node error the usual 0.8 s', async () => {
    const a = rpc(['429', 'down', 'ok']);
    const r = new FallbackReader(['https://rpc.mainnet.chain.robinhood.com'], 4663, [a.p]);
    expect(await settle(r.call(tx))).toEqual({ v: '0x01' });
    expect(a.at.map((t) => t - T0)).toEqual([0, 1000, 1800]);
  });

  it('two RPCs: a 429 moves to the other one at once, as before', async () => {
    const a = rpc(['429']), b = rpc(['ok']);
    const r = new FallbackReader(['https://a.example', 'https://b.example'], 369, [a.p, b.p]);
    expect(await settle(r.call(tx))).toEqual({ v: '0x01' });
    expect([a.at.map((t) => t - T0), b.at.map((t) => t - T0)]).toEqual([[0], [0]]);
  });

  it('three RPCs all down: each tried once, straight away, then the error, as before', async () => {
    const a = rpc(['down', 'down']), b = rpc(['down']), c = rpc(['down']);
    const r = new FallbackReader(['https://a.example', 'https://b.example', 'https://c.example'], 1, [a.p, b.p, c.p]);
    expect(await settle(r.call(tx))).toMatchObject({ e: 'connect ECONNREFUSED' });
    expect([a.at, b.at, c.at].map((x) => x.map((t) => t - T0))).toEqual([[0], [0], [0]]);
  });

  it('one RPC: a log query the node refuses as too wide is thrown at once; the endpoint stays healthy, no episode opens', async () => {
    // ethers' wrapping of Robinhood's answer to a wide eth_getLogs (a liquidity bot's swap-history sync, 2026-10-28)
    const wide = () => Object.assign(new Error('could not coalesce error (error={ "code": -32000, "message": "logs matched by query exceeds limit of 10000" }, payload={ "id": 750, "jsonrpc": "2.0", "method": "eth_getLogs", "params": [ ] }, code=UNKNOWN_ERROR, version=6.17.0)'), { code: 'UNKNOWN_ERROR' });
    let calls = 0;
    const p = { getLogs: async () => { calls++; throw wide(); } } as unknown as JsonRpcProvider;
    const r = new FallbackReader(['https://rpc.mainnet.chain.robinhood.com'], 4663, [p]);
    expect(await settle(r.getLogs({ address: '0x52e65B17fB6E5BA00Ed806f37Afcd2DaA50271Ca', topics: [], fromBlock: 1, toBlock: 2 } as never))).toMatchObject({ e: expect.stringMatching(/exceeds limit of 10000/) });
    expect(calls).toBe(1);
    expect(r.health().state).toBe('ok');
    expect(r.checkHealth(0)).toBeNull();
  });
});
