/** Pro Desk palette for canvas charts (lightweight-charts needs literal colours; keep in sync with styles.css :root). */
export const T = {
  bg: '#0B0E11',
  line: '#2B3139',
  line2: '#3C434D',
  text: '#EAECEF',
  muted: '#848E9C',
  profit: '#0ECB81',
  loss: '#F6465D',
  warn: '#F0B90B',
  font: "'IBM Plex Mono', ui-monospace, monospace",
} as const;

/** Indicator colours: muted, distinct from profit/loss so overlays never read as gains or losses. */
export const IND = {
  fast: '#B7BDC6',
  slow: '#848E9C',
  band: '#5E6673',
  rsi: '#B7BDC6',
  macd: '#B7BDC6',
  signal: '#F0B90B',
} as const;

export const alpha = (hex: string, a: number) => {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
};

/** Shared lightweight-charts layout options. */
export const chartBase = {
  layout: { background: { color: 'transparent' }, textColor: T.muted, fontFamily: T.font, panes: { separatorColor: T.line } },
  rightPriceScale: { borderColor: T.line },
};
