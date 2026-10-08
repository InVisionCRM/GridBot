import { analyzeEconomics, type EconReport } from '../../live/economics';
import type { MarketSnapshot, Quoter } from './chain';

export interface EconCfg { lowerPrice: number; upperPrice: number; gridCount: number; totalCapitalUsd: number }

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

export function econFromMarket(m: MarketSnapshot, cfg: EconCfg, approval: 'exact' | 'max'): EconReport {
  return analyzeEconomics({
    lowerPrice: cfg.lowerPrice, upperPrice: cfg.upperPrice, gridCount: cfg.gridCount, capital: cfg.totalCapitalUsd,
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
