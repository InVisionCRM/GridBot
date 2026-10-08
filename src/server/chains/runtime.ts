/**
 * Per-chain runtime: fallback reader, optional signer, its OWN TxGate + SharedNonce (one tx in flight per
 * chain; chains run in parallel), DEX adapters, the L2 L1-fee estimator and the gas-balance monitor.
 */
import type { ChainConfig } from '../../live/chains';
import type { ChainReader, TxSender } from '../bot/chain';
import { SharedNonce, TxGate } from '../bot/txGate';
import { ARB_NODE_INTERFACE, ARB_NODE_INTERFACE_ADDR, ERC20 } from '../dex/abis';
import type { DexAdapter } from '../dex/types';
import { V2Adapter } from '../dex/v2';
import { V3Adapter } from '../dex/v3';
import type { RpcStatus } from './fallback';

/** Reader surface the runtime may use (FallbackReader implements all; test mocks may omit the optional ones). */
export type RuntimeReader = ChainReader & {
  getCode?(a: string): Promise<string>;
  getStorage?(a: string, slot: string): Promise<string>;
  send?(method: string, params: unknown[]): Promise<unknown>;
  sendEach?(method: string, params: unknown[]): Promise<unknown>;
  status?: RpcStatus;
  currentUrl?: string;
};

export interface GasState { address: string | null; native: number | null; low: boolean; at: number | null; error: string | null }

export class ChainRuntime {
  readonly gate: TxGate;
  readonly nonce: SharedNonce;
  readonly adapters = new Map<string, DexAdapter>();
  gas: GasState = { address: null, native: null, low: false, at: null, error: null };
  private l1Cache: { at: number; size: number; v: { wei: bigint; separate: boolean } } | null = null;

  constructor(
    readonly cfg: ChainConfig, readonly reader: RuntimeReader, readonly signer: TxSender | null,
    o: { adapters?: DexAdapter[]; gate?: TxGate; nonce?: SharedNonce } = {},
  ) {
    this.gate = o.gate ?? new TxGate();
    this.nonce = o.nonce ?? new SharedNonce();
    const adapters = o.adapters;
    for (const a of adapters ?? cfg.dexes.map((d) => (d.kind === 'v2' ? new V2Adapter(reader, d, cfg.wrappedNative.address) : new V3Adapter(reader, d, cfg.wrappedNative.address)))) {
      this.adapters.set(a.cfg.id, a);
    }
  }

  adapter(id: string): DexAdapter {
    const a = this.adapters.get(id);
    if (!a) throw new Error(`${this.cfg.name}: unknown DEX ${id}`);
    return a;
  }

  get tradable() { return this.cfg.trading.enabled && this.adapters.size > 0; }

  /**
   * L1 component of an Arbitrum / Orbit L2 tx (cached 60 s per calldata size bucket):
   * NodeInterface.gasEstimateL1Component → extra L2 gas (already inside gasUsed on receipts, so never separate).
   */
  async l1Fee(to: string, data: string, gasPrice: bigint): Promise<{ wei: bigint; separate: boolean }> {
    if (this.cfg.stack === 'l1') return { wei: 0n, separate: false };
    const size = Math.ceil(data.length / 256);
    if (this.l1Cache && this.l1Cache.size === size && Date.now() - this.l1Cache.at < 60_000) return this.l1Cache.v;
    const raw = await this.reader.call({ to: ARB_NODE_INTERFACE_ADDR, data: ARB_NODE_INTERFACE.encodeFunctionData('gasEstimateL1Component', [to, false, data]) });
    const gasL1 = ARB_NODE_INTERFACE.decodeFunctionResult('gasEstimateL1Component', raw)[0] as bigint;
    const v = { wei: gasL1 * gasPrice, separate: false };
    this.l1Cache = { at: Date.now(), size, v };
    return v;
  }

  /** Signer's native balance; flags low gas below cfg.lowGasNative. */
  async refreshGas(): Promise<GasState> {
    if (!this.signer) return this.gas;
    try {
      const address = this.gas.address ?? await this.signer.getAddress();
      const native = Number(await this.reader.getBalance(address)) / 1e18;
      this.gas = { address, native, low: native < this.cfg.lowGasNative, at: Date.now(), error: null };
    } catch (e) {
      this.gas = { ...this.gas, error: (e as Error).message.slice(0, 160), at: Date.now() };
    }
    return this.gas;
  }

  async tokenBalance(owner: string, token: string): Promise<bigint> {
    const raw = await this.reader.call({ to: token, data: ERC20.encodeFunctionData('balanceOf', [owner]) });
    return ERC20.decodeFunctionResult('balanceOf', raw)[0] as bigint;
  }
}
