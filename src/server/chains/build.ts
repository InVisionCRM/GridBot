/** Wire the multi-chain hub from the registry + env (RPC overrides). Keys are handled only in env.ts. */
import type { JsonRpcProvider } from 'ethers';
import type { LiveNetwork } from '../../live/networks';
import type { ChainConfig } from '../../live/chains';
import { allChains, defaultMarkets, legacyMarkets } from '../../live/markets';
import type { TxSender } from '../bot/chain';
import type { Store } from '../bot/store';
import { FallbackReader, makeRpc } from './fallback';
import { Hub, type CustomFile } from './hub';
import { ChainRuntime } from './runtime';

/** RPC list for a chain: RPC_URL_<SLUG> (comma-separated) first, then legacy RPC_URL for PulseChain, then defaults. */
export function rpcUrlsFor(c: ChainConfig, env: Record<string, string | undefined>, legacyChainId = 369): string[] {
  const list = [
    ...(env[`RPC_URL_${c.envSlug}`] ?? '').split(','),
    ...(c.id === legacyChainId ? [env.RPC_URL ?? ''] : []),
    ...c.rpcs,
  ].map((s) => s.trim()).filter((s) => /^https?:\/\//.test(s));
  return [...new Set(list)];
}

/** Disable chains with CHAINS=pulsechain,base,… (default: all). */
export function enabledChains(net: LiveNetwork, env: Record<string, string | undefined>): ChainConfig[] {
  const all = allChains(net);
  const want = (env.CHAINS ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  return want.length ? all.filter((c) => c.id === net.chainId || want.includes(c.key)) : all;
}

export type SignerLike = { getAddress(): Promise<string>; connect(p: JsonRpcProvider): { sendTransaction(tx: { to: string; data: string; value: bigint; nonce: number }): Promise<unknown> } };

export interface Wiring {
  hub: Hub;
  readers: Map<number, FallbackReader>;
}

/**
 * signerFor receives the chain and its primary provider; the returned sender is re-bound to whichever RPC the
 * fallback reader currently uses, so a rate-limited endpoint doesn't block sending.
 */
export function buildHub(o: {
  net: LiveNetwork;
  env: Record<string, string | undefined>;
  signers?: Map<number, SignerLike>;
  /** Build signers once the per-chain providers exist (index.ts passes env.createSigners). */
  signerFactory?: (chains: { id: number; envSlug: string; provider: JsonRpcProvider }[]) => Map<number, SignerLike>;
  custom?: Store<CustomFile>;
  chains?: ChainConfig[];
}): Wiring {
  const chains = o.chains ?? enabledChains(o.net, o.env);
  const readers = new Map<number, FallbackReader>();
  for (const c of chains) {
    const urls = rpcUrlsFor(c, o.env, o.net.chainId);
    readers.set(c.id, new FallbackReader(urls, c.id, urls.map((u) => makeRpc(u, c.id))));
  }
  const signers = o.signers ?? o.signerFactory?.(chains.map((c) => ({ id: c.id, envSlug: c.envSlug, provider: readers.get(c.id)!.current })));
  const runtimes = chains.map((c) => {
    const reader = readers.get(c.id)!;
    const w = signers?.get(c.id);
    const signer: TxSender | null = w ? {
      getAddress: () => w.getAddress(),
      sendTransaction: (tx) => w.connect(reader.current).sendTransaction(tx) as ReturnType<TxSender['sendTransaction']>,
    } : null;
    return new ChainRuntime(c, reader, signer);
  });
  const hub = new Hub({ runtimes, markets: [...legacyMarkets(o.net), ...defaultMarkets(chains)], legacyNet: o.net, custom: o.custom });
  return { hub, readers };
}
