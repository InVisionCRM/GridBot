/**
 * Capital router settings service. Persists data/router.json through JsonStore (atomic, no secrets).
 * This module does not move funds. sendSafe.ts is the only broadcaster, and nothing calls it yet.
 * Host only: `host` must be passed true (the process is not a friend's copy). Otherwise the router stays off.
 * A restart does not re-arm: a file left on boots off until this process turns it on.
 */
import { requestHalt, type Halt } from '../bot/audit';
import { redact } from '../bot/logger';
import type { Store } from '../bot/store';
import {
  guardOn, HOST_ONLY, liveEnableError, MAX_ETA_BASIS, patchSettings, settingsFromFile,
  type RouterHalt, type RouterSettings, type TxKind,
} from './settings';

export interface BridgeConfigured { across: boolean; relay: boolean; lifi: boolean }

export interface RouterStatus extends RouterSettings {
  /** False on a friend's copy, and when the flag was not passed. The file cannot turn this on. */
  host: boolean;
  /** maxEtaMin is compared to the route's p90 ETA. */
  maxEtaBasis: typeof MAX_ETA_BASIS;
  /** Whether a quote key was set. Never the key. */
  configured: BridgeConfigured;
}

export interface RouterFile extends RouterSettings { version: 1 }

export class Router {
  readonly host: boolean;
  private state: RouterSettings;
  private readonly configured: BridgeConfigured;
  private readonly chainIds: number[];

  constructor(private readonly d: {
    store: Store<RouterFile>;
    /** True only on the host app (env.readCopy() == null). Omitted → off. */
    host?: boolean;
    configured?: BridgeConfigured;
    chainIds?: readonly number[];
    now?: () => number;
    emit?: (e: { type: 'stopped'; kind: 'system'; level: 'warn'; notify?: boolean; msg: string; data?: Record<string, unknown> }) => void;
    log?: { error(msg: string): void };
  }) {
    this.host = d.host === true;
    this.configured = {
      across: d.configured?.across === true,
      relay: d.configured?.relay === true,
      lifi: d.configured?.lifi === true,
    };
    this.chainIds = [...new Set((d.chainIds ?? []).filter((id) => Number.isInteger(id) && id > 0))];
    this.state = guardOn(settingsFromFile(d.store.load(), this.chainIds), this.host);
    this.save();
  }

  private now() { return this.d.now?.() ?? Date.now(); }

  status(): RouterStatus {
    const s = this.state;
    return {
      host: this.host,
      on: s.on,
      mode: s.mode,
      maxPerMoveUsd: s.maxPerMoveUsd,
      maxPerDayUsd: s.maxPerDayUsd,
      maxPerMoveUsdByChain: { ...s.maxPerMoveUsdByChain },
      maxPerDayUsdByChain: { ...s.maxPerDayUsdByChain },
      allowedChains: [...s.allowedChains],
      allowedBridges: [...s.allowedBridges],
      minNetGainTok: { ...s.minNetGainTok },
      minNetGainPct: s.minNetGainPct,
      maxSlippageBps: s.maxSlippageBps,
      maxEtaMin: s.maxEtaMin,
      maxEtaBasis: MAX_ETA_BASIS,
      cooldownMin: s.cooldownMin,
      maxMovesPerDay: s.maxMovesPerDay,
      minConfidence: s.minConfidence,
      gasCaps: copyCaps(s.gasCaps),
      maxGasPriceWei: { ...s.maxGasPriceWei },
      maxPriorityFeeWei: { ...s.maxPriorityFeeWei },
      autoClaim: s.autoClaim,
      halt: s.halt ? { subject: 'router', halt: { ...s.halt.halt } } : null,
      configured: { ...this.configured },
    };
  }

  /** Gas ceiling for one tx kind, or null when that chain is not loaded. */
  gasCap(chainId: number, kind: TxKind): bigint | null {
    const n = this.state.gasCaps[String(chainId)]?.[kind];
    return typeof n === 'number' ? BigInt(n) : null;
  }

  /** Wei per gas for one chain, or null when that chain is not loaded. */
  maxGasPriceWei(chainId: number): bigint | null {
    return weiOf(this.state.maxGasPriceWei[String(chainId)]);
  }

  /** Max tip for one chain, or null when that chain is not loaded. A suggestion above this aborts the send. */
  maxPriorityFeeWei(chainId: number): bigint | null {
    return weiOf(this.state.maxPriorityFeeWei[String(chainId)]);
  }

  /** Stop all / turn off. A queued send reads this inside the gate, before it takes a nonce. */
  isHalted(): boolean { return this.state.halt != null; }

  update(body: unknown): RouterStatus {
    if (!this.host) throw new Error(HOST_ONLY);
    const next = patchSettings(this.state, body, this.chainIds);
    const blocked = next.on ? liveEnableError(next) : null;
    if (blocked) throw new Error(blocked);
    const wasOn = this.state.on;
    this.state = { ...next, halt: next.on ? null : this.state.halt };
    if (wasOn && !this.state.on) this.halt(requestHalt('router-off', 'PUT /api/router', this.now()));
    else this.save();
    return this.status();
  }

  turnOn(): RouterStatus {
    if (!this.host) throw new Error(HOST_ONLY);
    const blocked = liveEnableError(this.state);
    if (blocked) throw new Error(blocked);
    this.state = { ...this.state, on: true, halt: null };
    this.save();
    return this.status();
  }

  turnOff(): RouterStatus {
    if (!this.host) throw new Error(HOST_ONLY);
    if (this.state.on) this.halt(requestHalt('router-off', 'POST /api/router/off', this.now()));
    return this.status();
  }

  /**
   * Stop all. Turns the router off and stores the same halt the bots got, marked subject 'router'.
   * Does not throw: a listener must not fail the stop.
   */
  halt(h: Halt) {
    const halt: RouterHalt = {
      subject: 'router',
      halt: { at: h.at, what: h.what, detail: h.detail, origin: h.origin, endpoint: h.endpoint ?? null, ua: h.ua ?? null },
    };
    this.state = { ...this.state, on: false, halt };
    try { this.save(); }
    catch (e) { this.note(`capital router halt was not saved: ${publicError(e)}`); }
    try {
      this.d.emit?.({
        type: 'stopped', kind: 'system', level: 'warn', notify: true,
        msg: 'capital router off — no new moves',
        data: { subject: 'router', halt },
      });
    } catch { /* a listener must not break Stop all */ }
  }

  /** A logger must not fail Stop all either. */
  private note(msg: string) {
    try { this.d.log?.error(redact(msg)); } catch { /* ignore */ }
  }

  private save() {
    const s = this.state;
    this.d.store.save({
      version: 1,
      on: s.on,
      mode: s.mode,
      maxPerMoveUsd: s.maxPerMoveUsd,
      maxPerDayUsd: s.maxPerDayUsd,
      maxPerMoveUsdByChain: s.maxPerMoveUsdByChain,
      maxPerDayUsdByChain: s.maxPerDayUsdByChain,
      allowedChains: s.allowedChains,
      allowedBridges: s.allowedBridges,
      minNetGainTok: s.minNetGainTok,
      minNetGainPct: s.minNetGainPct,
      maxSlippageBps: s.maxSlippageBps,
      maxEtaMin: s.maxEtaMin,
      cooldownMin: s.cooldownMin,
      maxMovesPerDay: s.maxMovesPerDay,
      minConfidence: s.minConfidence,
      gasCaps: s.gasCaps,
      maxGasPriceWei: s.maxGasPriceWei,
      maxPriorityFeeWei: s.maxPriorityFeeWei,
      autoClaim: s.autoClaim,
      halt: s.halt,
    });
  }
}

function weiOf(s: string | undefined): bigint | null {
  return typeof s === 'string' && /^\d+$/.test(s) ? BigInt(s) : null;
}

function publicError(e: unknown): string {
  return String((e as Error)?.message ?? e).replace(/https?:\/\/\S+/gi, '[rpc]').slice(0, 180);
}

function copyCaps(g: RouterSettings['gasCaps']): RouterSettings['gasCaps'] {
  const out: RouterSettings['gasCaps'] = {};
  for (const [id, row] of Object.entries(g)) out[id] = { ...row };
  return out;
}
