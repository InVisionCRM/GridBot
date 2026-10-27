/**
 * Print the reconstructed ETH/USDG week. Net quote (fees − gas − swap cost − move loss) leads each row.
 * No network, no wallet, no .env. The path and the assumptions are in src/market/ethUsdgReplay.ts.
 */
import { formatEthReplay, runEthUsdgReplay } from '../src/market/ethUsdgReplay';

const report = runEthUsdgReplay();
console.log(formatEthReplay(report));
console.log('');
for (const line of report.assumptions) console.log(`- ${line}`);
