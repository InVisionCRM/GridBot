/** Which bots a chart draws. An id in `off` is hidden. An empty list means every bot is on. */

export function toggleId(off: string[], id: string): string[] {
  return off.includes(id) ? off.filter((x) => x !== id) : [...off, id];
}

/** All on → turn every listed bot off. Otherwise turn them all on. */
export function toggleEvery(ids: string[], off: string[]): string[] {
  const allOn = ids.length > 0 && ids.every((id) => !off.includes(id));
  return allOn ? [...ids] : [];
}

export function allOn(ids: string[], off: string[]): boolean {
  return ids.length > 0 && ids.every((id) => !off.includes(id));
}

export function someOn(ids: string[], off: string[]): boolean {
  return ids.some((id) => !off.includes(id));
}

const keyOf = (chartId: string) => `desk-bots:${chartId}`;

export function readOff(chartId: string): string[] {
  try {
    const raw = localStorage.getItem(keyOf(chartId));
    if (!raw) return [];
    const parsed = JSON.parse(raw) as { off?: unknown };
    return Array.isArray(parsed.off) ? parsed.off.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

export function saveOff(chartId: string, off: string[]) {
  try { localStorage.setItem(keyOf(chartId), JSON.stringify({ off })); } catch { /* private mode */ }
}
