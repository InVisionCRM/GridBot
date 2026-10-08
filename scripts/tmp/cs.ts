import { getAddress } from 'ethers';
import { readFileSync } from 'fs';
for (const f of ['src/live/chains.ts', 'src/live/markets.ts', 'src/live/networks.ts', 'src/server/dex/safety.ts']) {
  const s = readFileSync(f, 'utf8');
  for (const m of s.matchAll(/0x[0-9a-fA-F]{40}(?![0-9a-fA-F])/g)) {
    const a = m[0];
    if (a === a.toLowerCase()) continue;
    try { if (getAddress(a) !== a) console.log(f, 'MISMATCH', a, '→', getAddress(a)); } catch { console.log(f, 'BAD', a, '→', getAddress(a.toLowerCase())); }
  }
}
