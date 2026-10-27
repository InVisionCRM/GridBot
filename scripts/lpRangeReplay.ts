/**
 * Headline: real GeckoTerminal candles and a sampled liquidity series.
 *   npx tsx scripts/lpRangeReplay.ts
 * The seeded Ornstein-Uhlenbeck path is a unit-test fixture only:
 *   npx tsx scripts/lpRangeReplay.ts --synthetic
 * No network, no wallet, no .env. The samples were read once and committed.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { formatEthReplay, runEthUsdgReplay } from '../src/market/ethUsdgReplay';
import {
  ethUsdcTable, fixtureRows, formatCandleTable, formatVsHold, hoodWeekTable, loadSeries,
  type LiquiditySeries, type Ohlcv,
} from '../src/market/lpCandleReplay';

function root(): string {
  return join(dirname(fileURLToPath(import.meta.url)), '..');
}

function loadCandles(name: string): Ohlcv[] {
  const data = JSON.parse(readFileSync(join(root(), 'tests/fixtures', name), 'utf8')) as { rows: number[][] };
  return fixtureRows(data);
}

function loadLiq(name: string): LiquiditySeries {
  return loadSeries(JSON.parse(readFileSync(join(root(), 'tests/fixtures', name), 'utf8')) as LiquiditySeries);
}

function printReal(): void {
  const eth = ethUsdcTable(loadCandles('eth-usdc-005-1h.json'), loadLiq('eth-usdc-005-liquidity.json'));
  const hood = hoodWeekTable(loadCandles('hood-ethusdg-5m.json'), loadLiq('hood-ethusdg-liquidity.json'));
  for (const table of [eth, hood]) {
    console.log(formatCandleTable(table));
    console.log('');
    console.log(table.source);
    console.log(formatVsHold(table.rows));
    console.log('');
    for (const line of table.assumptions) console.log(`- ${line}`);
    console.log('');
  }
  console.log('Also in tests/fixtures, not used above: eth-usdc-005-1m.json (about 3 days, gappy) and hood-ethusdg-1h.json (hourly; the README week above uses the 5-minute bars). Each file\'s note says how to page GeckoTerminal for more.');
  console.log('The seeded path is a synthetic test fixture. Print it with --synthetic. Its numbers are not this headline.');
}

const synthetic = process.argv.includes('--synthetic');
if (synthetic) {
  const report = runEthUsdgReplay();
  console.log('Synthetic test fixture (seeded path, not market data). Not the headline.');
  console.log(report.source);
  console.log('');
  console.log(formatEthReplay(report));
  console.log('');
  for (const line of report.assumptions) console.log(`- ${line}`);
} else {
  printReal();
}
