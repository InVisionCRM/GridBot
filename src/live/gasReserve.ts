/**
 * Gas reserve for grids / trend bots that SPEND the chain's native coin (flipped HEX/PLS, ETH-quoted markets).
 * Gas is paid from the same native balance as the capital, so a slice is kept aside and never counted as
 * tradable capital: reserve = max(pct × capital, fixed native amount). Live starts are blocked when
 * capital + reserve (+ what other live bots already allocated) exceeds the native balance.
 */
export interface GasReserveCfg {
  /** Fraction of the capital kept for gas (0.02 = 2 %) */
  pct: number;
  /** Fixed floor in native units (e.g. 5000 PLS); 0 = none */
  fixed: number;
}

export const DEFAULT_GAS_RESERVE: GasReserveCfg = { pct: 0.02, fixed: 0 };
export const GAS_RESERVE_MAX_PCT = 0.5;

/** Reads optional overrides from limits ({ gasReservePct, gasReserveNative }). */
export function reserveCfg(l?: { gasReservePct?: number; gasReserveNative?: number } | null): GasReserveCfg {
  return {
    pct: l?.gasReservePct != null && Number.isFinite(l.gasReservePct) ? l.gasReservePct : DEFAULT_GAS_RESERVE.pct,
    fixed: l?.gasReserveNative != null && Number.isFinite(l.gasReserveNative) ? l.gasReserveNative : DEFAULT_GAS_RESERVE.fixed,
  };
}

/** Native units kept for gas for a bot with `capital` native-coin capital. */
export function gasReserve(capital: number, cfg: GasReserveCfg = DEFAULT_GAS_RESERVE): number {
  return Math.max(Math.max(0, capital) * cfg.pct, cfg.fixed);
}

export interface ReserveCheck { ok: boolean; reserve: number; need: number; have: number; reason: string | null }

/**
 * capital (native) + reserve + already allocated ≤ native balance? `allocated` = native already committed to other
 * live bots (their free capital and held native lots).
 */
export function checkGasReserve(i: { capital: number; balance: number; allocated?: number; cfg?: GasReserveCfg; symbol: string }): ReserveCheck {
  const reserve = gasReserve(i.capital, i.cfg);
  const need = i.capital + reserve + (i.allocated ?? 0);
  const ok = i.balance + 1e-9 >= need;
  const f = (x: number) => x.toPrecision(6);
  return {
    ok, reserve, need, have: i.balance,
    reason: ok ? null : `${i.symbol} balance ${f(i.balance)} < capital ${f(i.capital)} + gas reserve ${f(reserve)}${i.allocated ? ` + allocated to other live bots ${f(i.allocated)}` : ''} = ${f(need)} (the reserve pays gas and is never traded)`,
  };
}

/**
 * Form input → cfg. "2%" = share of capital; "5000" = fixed native amount; "2% 5000" = max of both; "" = default.
 * Returns null for anything invalid or above the max share.
 */
export function parseGasRes(input: string): GasReserveCfg | null {
  const t = input.trim();
  if (!t) return { ...DEFAULT_GAS_RESERVE };
  let pct = 0, fixed = 0;
  for (const part of t.split(/[\s,+]+/).filter(Boolean)) {
    const m = /^(\d+(?:\.\d+)?)(%?)$/.exec(part);
    if (!m) return null;
    if (m[2]) pct = +m[1] / 100;
    else fixed = +m[1];
  }
  if (pct > GAS_RESERVE_MAX_PCT || !Number.isFinite(fixed)) return null;
  return { pct, fixed };
}
