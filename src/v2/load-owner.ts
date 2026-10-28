/**
 * Reads the gitignored owner snapshot when it is on disk.
 * Otherwise the sanitized fixture, so CI has nothing private to load.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { adaptStatus, type ActivityEvent } from './adapt-status';
import type { DeskSnapshot } from './metrics';
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
  return adaptStatus(status, events, undefined, 'snapshot');
}
