import { analyzeEconomics, type EconReport } from '../../live/economics';
import { DEFAULT_COSTS, type CostModel } from '../../market/costs';
import type { MarketSnapshot, Quoter } from './chain';

export interface EconCfg { lowerPrice: number; upperPrice: number; gridCount: number; totalCapitalQuote: number }

/** Compact economics for status/preview (drops the per-interval table). */
export type EconSummary = Omit<EconReport, 'intervals' | 'worst' | 'best'> & {
  quote: string;
  spot: number;
  poolQuote: number;
  poolPls: number;
  bestNetPct: number;
  worstInterval: number | null;
};

export function summarize(r: EconReport, quote: string, m: MarketSnapshot): EconSummary {
  const { intervals: _i, worst, best, ...rest } = r;
  return {
    ...rest, quote, spot: m.spot, poolQuote: m.quoteReserve, poolPls: m.plsReserve,
    bestNetPct: best?.netPct ?? 0, worstInterval: worst?.index ?? null,
  };
}

/** Backtest cost model from a pool + gas snapshot; null snapshot (offline) = LP fee only, no impact or gas. */
export function costModelOf(m: MarketSnapshot | null, feeBps: number, approval: 'exact' | 'max', o: { useImpact?: boolean; useGas?: boolean; slippageBps?: number } = {}): CostModel {
  const useGas = o.useGas !== false && !!m;
  return {
    feeBps: m?.feeBps ?? feeBps, approval, slippageBps: o.slippageBps ?? DEFAULT_COSTS.slippageBps,
    buyTaxPct: m?.buyTaxPct ?? 0, sellTaxPct: m?.sellTaxPct ?? 0,
    pool: o.useImpact !== false && m ? { quoteReserve: m.quoteReserve, plsReserve: m.plsReserve } : null,
    gasPricePls: useGas ? m!.gasPricePls : 0,
    gasUnits: m?.gasUnits, extraPlsPerSwap: useGas ? m!.extraPlsPerSwap ?? 0 : 0,
  };
}

export function econFromMarket(m: MarketSnapshot, cfg: EconCfg, approval: 'exact' | 'max'): EconReport {
  return analyzeEconomics({
    lowerPrice: cfg.lowerPrice, upperPrice: cfg.upperPrice, gridCount: cfg.gridCount, capital: cfg.totalCapitalQuote,
    spot: m.spot, pool: { quoteReserve: m.quoteReserve, plsReserve: m.plsReserve },
    gasPricePls: m.gasPricePls, approval,
    feeBps: m.feeBps, gasUnits: m.gasUnits, extraPlsPerSwap: m.extraPlsPerSwap,
    buyTaxPct: m.buyTaxPct, sellTaxPct: m.sellTaxPct,
  });
}

export async function gridEconomics(quoter: Quoter, cfg: EconCfg, approval: 'exact' | 'max') {
  const market = await quoter.market();
  const report = econFromMarket(market, cfg, approval);
  return { market, report, summary: summarize(report, quoter.stable.symbol, market) };
}
