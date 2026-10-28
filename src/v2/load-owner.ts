/**
 * Reads the gitignored owner snapshot when it is on disk.
 * Otherwise the sanitized fixture, so CI has nothing private to load.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { adaptStatus, type ActivityEvent } from './adapt-status';
import type { DeskSnapshot, HoldingLine } from './metrics';
import { sanitizedActivity, sanitizedStatus } from './sanitized-fixture';

export function loadDesk(): DeskSnapshot {
  const dir = join(process.cwd(), 'data', 'owner-snapshot');
  const statusPath = join(dir, 'bot_status.json');
  if (!existsSync(statusPath)) {
    return adaptStatus(sanitizedStatus as unknown as Record<string, unknown>, sanitizedActivity, sanitizedStatus.spotsAt, 'fixture');
  }
  const status = JSON.parse(readFileSync(statusPath, 'utf8')) as Record<string, unknown>;
  const events: ActivityEvent[] = [];
  const logPath = join(dir, 'activity.log');
  if (existsSync(logPath)) {
    for (const line of readFileSync(logPath, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try { events.push(JSON.parse(line) as ActivityEvent); } catch { /* skip a broken line */ }
    }
  }
  const desk = adaptStatus(status, events, undefined, 'snapshot');
  desk.holdings = readHoldings(dir);
  return desk;
}

function readHoldings(dir: string): HoldingLine[] {
  const path = join(dir, 'holdings.json');
  if (!existsSync(path)) return [];
  const file = JSON.parse(readFileSync(path, 'utf8')) as {
    chains?: { chainId?: number; name?: string }[];
    wallet?: { dust?: boolean; coin?: { chainId?: number; symbol?: string; amount?: number } }[];
    positions?: { chainId?: number; token0?: { symbol?: string; amount?: number }; token1?: { symbol?: string; amount?: number } }[];
  };
  const names = new Map((file.chains ?? []).map((c) => [c.chainId, c.name || '']));
  const out: HoldingLine[] = [];
  const push = (symbol: string | undefined, amount: number | undefined, chainId: number | undefined) => {
    if (!symbol || typeof amount !== 'number' || !Number.isFinite(amount) || amount === 0) return;
    out.push({ symbol, amount, chain: names.get(chainId) || '' });
  };
  for (const row of file.wallet ?? []) {
    if (row.dust) continue;
    push(row.coin?.symbol, row.coin?.amount, row.coin?.chainId);
  }
  for (const row of file.positions ?? []) {
    push(row.token0?.symbol, row.token0?.amount, row.chainId);
    push(row.token1?.symbol, row.token1?.amount, row.chainId);
  }
  return out;
}
