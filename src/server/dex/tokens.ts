/** Token metadata + contract checks for "add a token by address". Read-only. */
import { decodeBytes32String, getAddress, id, isAddress } from 'ethers';
import { decimalsWarning, parseDecimalsWord, readDecimals } from '../../live/decimals';
import { ERC20, ERC20_B32 } from './abis';
import type { RuntimeReader } from '../chains/runtime';

export interface TokenMeta {
  chainId: number;
  address: string;
  symbol: string;
  name: string;
  decimals: number;
  totalSupply: string | null;
  codeSize: number;
  proxy: { kind: string; implementation?: string } | null;
  /** Heuristic flags from common views (maxTx / maxWallet / blacklist / paused). */
  flags: TokenFlags;
  warnings: string[];
}

export interface TokenFlags {
  /** Raw-unit max transaction amount (maxTxAmount() & co.), null = none found */
  maxTx: string | null;
  /** Raw-unit max wallet balance (maxWallet() & co.), null = none found */
  maxWallet: string | null;
  /** Signature of a blacklist view that exists (isBlacklisted(address) …) = owner can blacklist wallets */
  blacklist: string | null;
  /** true = paused() is true or tradingEnabled()/tradingOpen() is false */
  paused: boolean | null;
  pausedBy: string | null;
}

/** Storage slots / bytecode patterns of common proxy standards. */
export const PROXY_SLOTS: { kind: string; slot: string }[] = [
  { kind: 'EIP-1967', slot: '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc' },
  { kind: 'EIP-1967 beacon', slot: '0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50' },
  { kind: 'EIP-1822', slot: '0xc5f16f0fcc639fa48a6947836d9850f504798523bf8c9a3a87d5f7a8a2a0b0b1' },
  { kind: 'OpenZeppelin (legacy)', slot: '0x7050c9e0f4ca769c69bd3a8ef740bc37934f8e2c036e5a723fd8ee048ed3f8c3' },
];
const MINIMAL_PROXY = /^0x363d3d373d3d3d363d73([0-9a-f]{40})5af43d82803e903d91602b57fd5bf3/i;

const slotAddr = (v: string) => {
  const h = v.replace(/^0x/, '').padStart(64, '0');
  return /^0+$/.test(h) ? null : getAddress('0x' + h.slice(24));
};

export async function detectProxy(reader: RuntimeReader, address: string, code: string): Promise<TokenMeta['proxy']> {
  const m = code.match(MINIMAL_PROXY);
  if (m) return { kind: 'EIP-1167 minimal proxy', implementation: getAddress('0x' + m[1]) };
  if (!reader.getStorage) return null;
  for (const p of PROXY_SLOTS) {
    try {
      const a = slotAddr(await reader.getStorage(address, p.slot));
      if (a) return { kind: p.kind, implementation: a };
    } catch { /* RPC without eth_getStorageAt */ }
  }
  if (code.length < 2 + 2 * 400 && /f4/i.test(code.slice(2))) return { kind: 'delegatecall proxy (non-standard)' };
  return null;
}

async function str(reader: RuntimeReader, to: string, fn: 'symbol' | 'name'): Promise<string | null> {
  try {
    const raw = await reader.call({ to, data: ERC20.encodeFunctionData(fn) });
    try { return String(ERC20.decodeFunctionResult(fn, raw)[0]); } catch {
      try { return decodeBytes32String(ERC20_B32.decodeFunctionResult(fn, raw)[0] as string); } catch { return null; }
    }
  } catch { return null; }
}

/** Common non-standard views used by taxed / anti-bot tokens (selectors derived from the signatures, never typed). */
const sel = (sig: string) => id(sig).slice(0, 10);
const UINT_VIEWS: { key: 'maxTx' | 'maxWallet'; sig: string }[] = [
  { key: 'maxTx', sig: 'maxTxAmount()' }, { key: 'maxTx', sig: '_maxTxAmount()' }, { key: 'maxTx', sig: 'maxTransactionAmount()' },
  { key: 'maxWallet', sig: 'maxWallet()' }, { key: 'maxWallet', sig: 'maxWalletAmount()' }, { key: 'maxWallet', sig: 'maxWalletToken()' },
  { key: 'maxWallet', sig: '_maxWalletSize()' }, { key: 'maxWallet', sig: 'maxWalletSize()' },
];
/** paused() true = blocked; tradingEnabled()/tradingOpen() false = blocked (not launched yet / switched off). */
const PAUSE_VIEWS: { sig: string; pausedWhen: boolean }[] = [
  { sig: 'paused()', pausedWhen: true }, { sig: 'tradingEnabled()', pausedWhen: false }, { sig: 'tradingOpen()', pausedWhen: false },
];
/** isBlacklisted(address) & co. — existence = the owner can blacklist; probed with address(0). */
const BLACKLIST_VIEWS = ['isBlacklisted(address)', 'isBlackListed(address)', 'isBot(address)', 'bots(address)'];
const PROBE_ARG = '0'.repeat(64); // abi-encoded address(0)

async function readU256(reader: RuntimeReader, to: string, data: string): Promise<bigint | null> {
  try {
    const raw = await reader.call({ to, data });
    if (!raw || raw === '0x' || raw.length < 66) return null;
    return BigInt(raw);
  } catch { return null; }
}
async function readBool(reader: RuntimeReader, to: string, data: string): Promise<boolean | null> {
  try {
    const raw = await reader.call({ to, data });
    if (!raw || raw === '0x' || raw.length !== 66) return null;
    const v = BigInt(raw);
    return v === 0n ? false : v === 1n ? true : null;
  } catch { return null; }
}

/** Heuristic flags for anti-bot / max-tx / blacklist / pausable tokens. Best-effort — a missing selector is fine. */
export async function readTokenFlags(reader: RuntimeReader, address: string): Promise<TokenFlags> {
  const flags: TokenFlags = { maxTx: null, maxWallet: null, blacklist: null, paused: null, pausedBy: null };
  for (const v of UINT_VIEWS) {
    if (flags[v.key] != null) continue;
    const n = await readU256(reader, address, sel(v.sig));
    // type(uint256).max / ≥ 1e60 = "no limit"
    if (n != null && n > 0n && n < 10n ** 60n) flags[v.key] = n.toString();
  }
  for (const v of PAUSE_VIEWS) {
    const b = await readBool(reader, address, sel(v.sig));
    if (b == null) continue;
    if (b === v.pausedWhen) { flags.paused = true; flags.pausedBy = v.sig; break; }
    flags.paused = false;
  }
  for (const sig of BLACKLIST_VIEWS) {
    const b = await readBool(reader, address, sel(sig) + PROBE_ARG);
    if (b != null) { flags.blacklist = sig; break; }
  }
  return flags;
}

export async function readTokenMeta(reader: RuntimeReader, chainId: number, address: string): Promise<TokenMeta> {
  const a = address.trim();
  if (!isAddress(a)) throw new Error(`Not a valid address: ${String(address).slice(0, 60)}`);
  const addr = getAddress(a.toLowerCase());
  if (/^0x0{40}$/i.test(addr)) throw new Error('Zero address');
  const code = reader.getCode ? await reader.getCode(addr) : '0x00';
  if (!code || code === '0x') throw new Error(`No contract code at ${addr} on chain ${chainId} (wallet address, wrong chain, or not deployed)`);
  const warnings: string[] = [];
  // Always read decimals on-chain (cached). Handles uint8 and uint256 returns; rejects missing / >36.
  let decimals: number;
  try {
    decimals = await readDecimals(reader, chainId, addr);
  } catch (e) {
    // Fall back to a one-shot decode so the error message stays readable when the cache path hasn't run yet.
    try {
      const raw = await reader.call({ to: addr, data: ERC20.encodeFunctionData('decimals') });
      decimals = parseDecimalsWord(raw, addr);
    } catch { throw e; }
  }
  const dw = decimalsWarning(decimals);
  if (dw) warnings.push(dw);
  const [symbol, name] = await Promise.all([str(reader, addr, 'symbol'), str(reader, addr, 'name')]);
  if (!symbol) warnings.push('symbol() unreadable');
  let totalSupply: string | null = null;
  try {
    const ts = ERC20.decodeFunctionResult('totalSupply', await reader.call({ to: addr, data: ERC20.encodeFunctionData('totalSupply') }))[0] as bigint;
    totalSupply = ts.toString();
    if (ts === 0n) warnings.push('totalSupply() is 0');
  } catch { warnings.push('totalSupply() unreadable'); }
  try {
    await reader.call({ to: addr, data: ERC20.encodeFunctionData('balanceOf', ['0x000000000000000000000000000000000000dEaD']) });
  } catch { throw new Error(`${addr} does not implement ERC-20 balanceOf()`); }
  const [proxy, flags] = await Promise.all([detectProxy(reader, addr, code), readTokenFlags(reader, addr)]);
  if (proxy) warnings.push(`Upgradeable/proxy contract (${proxy.kind}) — its owner can change the token logic.`);
  if (flags.maxTx) warnings.push(`maxTxAmount = ${flags.maxTx} (raw units) — large buys/sells may revert.`);
  if (flags.maxWallet) warnings.push(`maxWallet = ${flags.maxWallet} (raw units) — accumulating above the cap reverts.`);
  if (flags.blacklist) warnings.push(`${flags.blacklist} exists — the owner can blacklist wallets (a blacklisted bot cannot sell).`);
  if (flags.paused === true) warnings.push(`${flags.pausedBy} says trading is paused / not enabled.`);
  return {
    chainId, address: addr, symbol: (symbol ?? 'TKN').replace(/[\u0000-\u001f]/g, '').trim().slice(0, 24) || 'TKN',
    name: (name ?? symbol ?? 'Unknown token').replace(/[\u0000-\u001f]/g, '').trim().slice(0, 64),
    decimals, totalSupply, codeSize: (code.length - 2) / 2, proxy, flags, warnings,
  };
}

export { readDecimals, clearDecimalsCache } from '../../live/decimals';
