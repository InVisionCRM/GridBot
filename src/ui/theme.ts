/** Night Desk palette for canvas charts (lightweight-charts needs literal colours; keep in sync with styles.css :root). */
export const T = {
  bg: '#0b0f0e',
  line: '#1f2a27',
  line2: '#2c3a36',
  text: '#e6efec',
  muted: '#7f918b',
  profit: '#3dffa2',
  loss: '#ff6b6b',
  warn: '#f2c14e',
  font: "'Jost', 'Avenir Next', sans-serif",
} as const;

/** Indicator colours: muted, distinct from profit/loss so overlays never read as gains or losses. */
export const IND = {
  fast: '#c9d4d0',
  slow: '#6f8f86',
  band: '#4f625c',
  rsi: '#a9b8b3',
  macd: '#c9d4d0',
  signal: '#f2c14e',
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
