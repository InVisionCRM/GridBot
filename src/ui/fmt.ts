/** Number formatting for dense tables. Prices are quote per PLS (often < 1e-4). */
export const px = (x: number | null | undefined, sig = 6) => {
  if (x == null || !Number.isFinite(x)) return '—';
  if (Math.abs(x) >= 1000) return x.toLocaleString(undefined, { maximumFractionDigits: 2 });
  if (Math.abs(x) >= 1) return x.toLocaleString(undefined, { maximumFractionDigits: 4 });
  return Number(x.toPrecision(sig)).toString().replace(/e-(\d)$/, 'e-0$1');
};
export const num = (x: number | null | undefined, d = 2) => (x == null || !Number.isFinite(x) ? '—' : x.toLocaleString(undefined, { maximumFractionDigits: d }));
export const pct = (x: number | null | undefined, d = 2, sign = false) =>
  x == null || !Number.isFinite(x) ? '—' : `${sign && x > 0 ? '+' : ''}${(x * 100).toFixed(d)}%`;
export const usd = (x: number | null | undefined, sign = false) => {
  if (x == null || !Number.isFinite(x)) return '—';
  const a = Math.abs(x);
  const s = a >= 1000 ? a.toLocaleString(undefined, { maximumFractionDigits: 0 }) : a.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: a < 1 ? 4 : 2 });
  return `${x < 0 ? '−' : sign && x > 0 ? '+' : ''}$${s}`;
};
export const qty = (x: number | null | undefined, sym: string, sig = 5, sign = true) =>
  x == null || !Number.isFinite(x) ? '—' : `${sign ? (x >= 0 ? '+' : '−') : x < 0 ? '−' : ''}${Number(Math.abs(x).toPrecision(sig)).toLocaleString(undefined, { maximumFractionDigits: 10 })} ${sym}`;
export const cls = (x: number | null | undefined) => (x == null ? '' : x > 0 ? 'pos' : x < 0 ? 'neg' : '');
export const ago = (ms: number | null | undefined, now = Date.now()) => {
  if (!ms) return '—';
  const s = Math.max(0, Math.round((now - ms) / 1000));
  return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.round(s / 60)}m ago` : s < 86_400 ? `${Math.round(s / 3600)}h ago` : `${Math.round(s / 86_400)}d ago`;
};
export const dur = (ms: number | null | undefined) => {
  if (ms == null) return '—';
  const m = Math.round(ms / 60_000);
  return m < 60 ? `${m}m` : m < 1440 ? `${(m / 60).toFixed(1)}h` : `${(m / 1440).toFixed(1)}d`;
};
export const time = (ms: number) => new Date(ms).toLocaleString(undefined, { month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit' });
