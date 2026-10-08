/**
 * In-memory PulseX V2 mock: one WPLS/<quote> pool per quote token, each with its own pair address,
 * token0 ordering and reserves held in the token's OWN raw decimals (DAI 18, USDC 6, HEX 8, …).
 * Raw-unit constant product means any decimals or reserve-order mistake in the bot shows up as a
 * wildly wrong price instead of being masked by the mock.
 */
import { zeroPadValue, toBeHex, getAddress } from 'ethers';
import { NETWORKS, type QuoteToken } from '../../src/live/networks';
import { getAmountOut } from '../../src/live/swapMath';
import { ERC20, FACTORY, PAIR, ROUTER, WPLS_EVENTS, type ChainReader, type ReceiptLike, type SentTx, type TxSender } from '../../src/server/bot/chain';

export const NET = NETWORKS.mainnet;
export const DAI = NET.quotes.find((s) => s.symbol === 'DAI')!;
export const HEX = NET.quotes.find((s) => s.symbol === 'HEX')!;
export const ALL_STABLES = NET.quotes;
export const ME = '0x1234567890123456789012345678901234567890';
const E18 = 10n ** 18n;
const WPLS = NET.pulsex.wpls.toLowerCase();

export type Fault = 'sendThrow' | 'revert' | 'timeout';

export interface Pool {
  q: QuoteToken;
  pair: string;
  /** Quote reserve, raw units in q.decimals */
  rQ: bigint;
  /** WPLS reserve, raw 18-dec */
  rW: bigint;
  token0IsQuote: boolean;
}

const pairAddr = (i: number) => getAddress('0x' + (0xa000 + i).toString(16).padStart(40, '0'));
export const PAIR_ADDR = pairAddr(0);

export class MockChain implements ChainReader, TxSender {
  pools: Pool[];
  allowances = new Map<string, bigint>();
  balances = new Map<string, bigint>();
  pls = 1_000_000_000n * E18;
  minedNonce = 0;
  sent: { to: string; method: string; nonce: number; value: bigint; args: unknown[] }[] = [];
  receipts = new Map<string, ReceiptLike>();
  faults: Fault[] = [];
  gasPrice = 10n ** 12n; // 1000 gwei → 100k gas = 0.1 PLS
  onSend?: (method: string) => void;
  txCountCalls = 0;
  /** Inject a pricing bug into getAmountsOut for tests that prove detection */
  corrupt: ((amountIn: bigint, amountOut: bigint, path: string[]) => bigint) | null = null;

  constructor(price = 0.00001, opts: { quoteDepth?: number } = {}) {
    const depth = opts.quoteDepth ?? 1_000_000;
    this.pools = NET.quotes.map((q, i) => ({
      q, pair: pairAddr(i),
      rQ: BigInt(depth) * 10n ** BigInt(q.decimals),
      rW: 0n,
      // DAI: token0 = quote; HEX/eHEX: token0 = WPLS (exercise both reserve orders)
      token0IsQuote: !(q.symbol === 'HEX' || q.symbol === 'eHEX'),
    }));
    for (const q of NET.quotes) this.balances.set(q.address.toLowerCase(), 1_000n * 10n ** BigInt(q.decimals));
    this.setPrice(price);
  }

  pool(sym: string): Pool {
    const p = this.pools.find((x) => x.q.symbol === sym);
    if (!p) throw new Error(`mock: no pool ${sym}`);
    return p;
  }
  private poolByToken(addr: string): Pool | undefined {
    return this.pools.find((x) => x.q.address.toLowerCase() === addr.toLowerCase());
  }

  /** Set pool mid price (quote per PLS, human units) by moving WPLS reserve. No symbol = every pool. */
  setPrice(p: number, sym?: string) {
    for (const pool of sym ? [this.pool(sym)] : this.pools) {
      const qHuman = Number(pool.rQ) / 10 ** pool.q.decimals;
      pool.rW = BigInt(Math.round(qHuman / p)) * E18;
    }
  }
  /** Human mid price of a pool (quote per PLS) */
  mid(sym = 'DAI') {
    const p = this.pool(sym);
    return (Number(p.rQ) / 10 ** p.q.decimals) / (Number(p.rW) / 1e18);
  }

  // Back-compat accessors for the DAI pool / DAI balance used by older tests
  get rD() { return this.pool('DAI').rQ; }
  set rD(v: bigint) { this.pool('DAI').rQ = v; }
  get rW() { return this.pool('DAI').rW; }
  set rW(v: bigint) { this.pool('DAI').rW = v; }
  get allowance() { return this.allowances.get(DAI.address.toLowerCase()) ?? 0n; }
  set allowance(v: bigint) { this.allowances.set(DAI.address.toLowerCase(), v); }
  get dai() { return this.balances.get(DAI.address.toLowerCase()) ?? 0n; }
  set dai(v: bigint) { this.balances.set(DAI.address.toLowerCase(), v); }
  bal(sym: string) { return this.balances.get(this.pool(sym).q.address.toLowerCase()) ?? 0n; }
  setBal(sym: string, human: number) { const q = this.pool(sym).q; this.balances.set(q.address.toLowerCase(), BigInt(Math.round(human * 10 ** q.decimals))); }

  /** Raw-unit constant-product swap on the pool of the non-WPLS token in path. */
  private out(amountIn: bigint, path: string[]) {
    const wIn = path[0].toLowerCase() === WPLS;
    const pool = this.poolByToken(wIn ? path[1] : path[0]);
    if (!pool) throw new Error('mock: no pool for path');
    const o = wIn ? getAmountOut(amountIn, pool.rW, pool.rQ, 29) : getAmountOut(amountIn, pool.rQ, pool.rW, 29);
    return { pool, wIn, out: this.corrupt ? this.corrupt(amountIn, o, path) : o };
  }

  async call({ to, data }: { to: string; data: string }): Promise<string> {
    const t = to.toLowerCase();
    if (t === NET.pulsex.routerV2.toLowerCase()) {
      const f = ROUTER.parseTransaction({ data })!;
      const [amountIn, path] = f.args as unknown as [bigint, string[]];
      return ROUTER.encodeFunctionResult('getAmountsOut', [[amountIn, this.out(amountIn, path).out]]);
    }
    if (t === NET.pulsex.factoryV2.toLowerCase()) {
      const f = FACTORY.parseTransaction({ data })!;
      const [a, b] = f.args as unknown as [string, string];
      const other = a.toLowerCase() === WPLS ? b : a;
      return FACTORY.encodeFunctionResult('getPair', [this.poolByToken(other)?.pair ?? '0x' + '0'.repeat(40)]);
    }
    const pool = this.pools.find((p) => p.pair.toLowerCase() === t);
    if (pool) {
      const f = PAIR.parseTransaction({ data })!;
      if (f.name === 'token0') return PAIR.encodeFunctionResult('token0', [pool.token0IsQuote ? pool.q.address : NET.pulsex.wpls]);
      const [r0, r1] = pool.token0IsQuote ? [pool.rQ, pool.rW] : [pool.rW, pool.rQ];
      return PAIR.encodeFunctionResult('getReserves', [r0, r1, 0]);
    }
    // ERC-20 metadata + balances: WPLS, every quote token, and any address we've given a balance.
    const meta = t === WPLS ? { decimals: 18, symbol: 'WPLS', name: 'Wrapped PLS' }
      : this.poolByToken(t) ? { decimals: this.poolByToken(t)!.q.decimals, symbol: this.poolByToken(t)!.q.symbol, name: this.poolByToken(t)!.q.symbol }
      : this.balances.has(t) ? { decimals: 18, symbol: 'TKN', name: 'TKN' } : null;
    if (meta) {
      const f = ERC20.parseTransaction({ data })!;
      if (f.name === 'decimals') return ERC20.encodeFunctionResult('decimals', [meta.decimals]);
      if (f.name === 'symbol') return ERC20.encodeFunctionResult('symbol', [meta.symbol]);
      if (f.name === 'name') return ERC20.encodeFunctionResult('name', [meta.name]);
      if (f.name === 'totalSupply') return ERC20.encodeFunctionResult('totalSupply', [10n ** 30n]);
      if (f.name === 'allowance') return ERC20.encodeFunctionResult('allowance', [this.allowances.get(t) ?? 0n]);
      if (f.name === 'balanceOf') return ERC20.encodeFunctionResult('balanceOf', [this.balances.get(t) ?? 0n]);
    }
    throw new Error(`mock: unexpected call to ${to}`);
  }

  async getBalance() { return this.pls; }
  async getFeeData() { return { gasPrice: this.gasPrice, maxFeePerGas: this.gasPrice }; }
  async getTransactionCount() { this.txCountCalls++; return this.minedNonce; }
  async getTransactionReceipt(hash: string) { return this.receipts.get(hash) ?? null; }
  async getAddress() { return ME; }

  async sendTransaction(tx: { to: string; data: string; value: bigint; nonce: number }): Promise<SentTx> {
    const tokenTo = this.poolByToken(tx.to);
    const iface = tokenTo ? ERC20 : ROUTER;
    const parsed = iface.parseTransaction({ data: tx.data, value: tx.value })!;
    this.onSend?.(parsed.name);
    const fault = this.faults.shift();
    if (fault === 'sendThrow') throw new Error('mock: nonce too low / network error');
    if (tx.nonce !== this.minedNonce) throw new Error(`mock: bad nonce ${tx.nonce}, expected ${this.minedNonce}`);
    this.minedNonce++;
    this.sent.push({ to: tx.to, method: parsed.name, nonce: tx.nonce, value: tx.value, args: [...parsed.args] });
    const hash = toBeHex(BigInt(this.sent.length) * 0x1111n, 32);
    const gas = { gasUsed: 100_000n, gasPrice: this.gasPrice };
    this.pls -= gas.gasUsed * gas.gasPrice;
    let receipt: ReceiptLike;
    if (fault === 'revert') {
      receipt = { status: 0, ...gas, logs: [] };
    } else if (parsed.name === 'approve') {
      this.allowances.set(tx.to.toLowerCase(), parsed.args[1] as bigint);
      receipt = { status: 1, ...gas, logs: [] };
    } else if (parsed.name === 'swapExactTokensForETH' || parsed.name === 'swapExactTokensForETHSupportingFeeOnTransferTokens') {
      const [amountIn, minOut, path] = parsed.args as unknown as [bigint, bigint, string[]];
      const tk = path[0].toLowerCase();
      if ((this.allowances.get(tk) ?? 0n) < amountIn) throw new Error('mock: TRANSFER_FROM_FAILED (no allowance)');
      if ((this.balances.get(tk) ?? 0n) < amountIn) throw new Error('mock: TRANSFER_FROM_FAILED (balance)');
      const { pool, out } = this.out(amountIn, path);
      if (out < minOut) receipt = { status: 0, ...gas, logs: [] };
      else {
        pool.rQ += amountIn; pool.rW -= out;
        this.balances.set(tk, (this.balances.get(tk) ?? 0n) - amountIn);
        this.allowances.set(tk, (this.allowances.get(tk) ?? 0n) - amountIn);
        this.pls += out;
        const ev = WPLS_EVENTS.getEvent('Withdrawal')!;
        receipt = { status: 1, ...gas, logs: [{ address: NET.pulsex.wpls, topics: [ev.topicHash, zeroPadValue(NET.pulsex.routerV2, 32)], data: zeroPadValue(toBeHex(out), 32) }] };
      }
    } else if (parsed.name === 'swapExactETHForTokens' || parsed.name === 'swapExactETHForTokensSupportingFeeOnTransferTokens') {
      const [minOut, path, to] = parsed.args as unknown as [bigint, string[], string];
      const { pool, out } = this.out(tx.value, path);
      if (out < minOut) receipt = { status: 0, ...gas, logs: [] };
      else {
        pool.rW += tx.value; pool.rQ -= out; this.pls -= tx.value;
        const tk = pool.q.address.toLowerCase();
        this.balances.set(tk, (this.balances.get(tk) ?? 0n) + out);
        const ev = ERC20.getEvent('Transfer')!;
        receipt = { status: 1, ...gas, logs: [{ address: pool.q.address, topics: [ev.topicHash, zeroPadValue(pool.pair, 32), zeroPadValue(to, 32)], data: zeroPadValue(toBeHex(out), 32) }] };
      }
    } else if (parsed.name === 'swapExactTokensForTokens' || parsed.name === 'swapExactTokensForTokensSupportingFeeOnTransferTokens') {
      const [amountIn, minOut, path, to] = parsed.args as unknown as [bigint, bigint, string[], string];
      const tk = path[0].toLowerCase();
      if ((this.allowances.get(tk) ?? 0n) < amountIn) throw new Error('mock: TRANSFER_FROM_FAILED (no allowance)');
      if ((this.balances.get(tk) ?? 0n) < amountIn) throw new Error('mock: TRANSFER_FROM_FAILED (balance)');
      const { pool, out } = this.out(amountIn, path);
      if (out < minOut) receipt = { status: 0, ...gas, logs: [] };
      else {
        // Sell quote → WPLS path already handled above; TokensForTokens here is for custom-token tests (quote ↔ token).
        const inIsQuote = tk === pool.q.address.toLowerCase();
        if (inIsQuote) { pool.rQ += amountIn; pool.rW -= out; this.balances.set(tk, (this.balances.get(tk) ?? 0n) - amountIn); this.balances.set(NET.pulsex.wpls.toLowerCase(), (this.balances.get(NET.pulsex.wpls.toLowerCase()) ?? 0n) + out); }
        else { pool.rW += amountIn; pool.rQ -= out; this.balances.set(tk, (this.balances.get(tk) ?? 0n) - amountIn); this.balances.set(pool.q.address.toLowerCase(), (this.balances.get(pool.q.address.toLowerCase()) ?? 0n) + out); }
        this.allowances.set(tk, (this.allowances.get(tk) ?? 0n) - amountIn);
        const outTok = path[1];
        const ev = ERC20.getEvent('Transfer')!;
        receipt = { status: 1, ...gas, logs: [{ address: outTok, topics: [ev.topicHash, zeroPadValue(pool.pair, 32), zeroPadValue(to, 32)], data: zeroPadValue(toBeHex(out), 32) }] };
      }
    } else throw new Error(`mock: unexpected method ${parsed.name}`);
    if (fault === 'timeout') {
      // Mined, but the bot's wait() times out; receipt only discoverable later by hash.
      const r = receipt;
      return { hash, wait: async () => { this.receipts.set(hash, r); throw Object.assign(new Error('timeout'), { code: 'TIMEOUT' }); } };
    }
    this.receipts.set(hash, receipt);
    return { hash, wait: async () => (receipt.status === 1 ? receipt : Promise.reject(Object.assign(new Error('CALL_EXCEPTION'), { receipt }))) };
  }
}
