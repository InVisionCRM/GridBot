/** Terminal Mint palette for canvas charts (lightweight-charts needs literal colours; keep in sync with styles.css :root). */
export const T = {
  bg: '#0E0F11',
  line: '#2A2E34',
  line2: '#363B42',
  text: '#ECEFF1',
  muted: '#8A9199',
  profit: '#5CD08D',
  loss: '#F2706B',
  warn: '#F5B841',
  hold: '#5B8DEF',
  font: "'DM Mono', ui-monospace, monospace",
} as const;

/** Indicator colours: muted, distinct from profit/loss so overlays never read as gains or losses. */
export const IND = {
  fast: '#B4BAC2',
  slow: '#8A9199',
  band: '#5E6673',
  rsi: '#B4BAC2',
  macd: '#B4BAC2',
  signal: '#F5B841',
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
