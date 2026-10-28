/** Small original marks for the header and holdings. Not trademark artwork. */
import type { ReactNode } from 'react';

type Glyph = 'eth' | 'pls' | 'hex' | 'dai' | 'usd' | 'letter';
const KNOWN: Record<string, { bg: string; fg: string; glyph: Glyph }> = {
  ETH: { bg: '#8c9eff', fg: '#0b1026', glyph: 'eth' },
  WETH: { bg: '#8c9eff', fg: '#0b1026', glyph: 'eth' },
  PLS: { bg: '#e040fb', fg: '#1a041c', glyph: 'pls' },
  WPLS: { bg: '#e040fb', fg: '#1a041c', glyph: 'pls' },
  HEX: { bg: '#ff4d6d', fg: '#fff', glyph: 'hex' },
  DAI: { bg: '#f5ac37', fg: '#1a1204', glyph: 'dai' },
  USDC: { bg: '#2775ca', fg: '#fff', glyph: 'usd' },
  USDT: { bg: '#26a17b', fg: '#fff', glyph: 'usd' },
  USDG: { bg: '#d6ff3f', fg: '#142000', glyph: 'usd' },
};

function hue(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 33 + seed.charCodeAt(i)) >>> 0;
  return `hsl(${h % 360} 62% 58%)`;
}

export function TokenMark({ symbol, address, size = 28 }: { symbol: string; address?: string | null; size?: number }) {
  const known = KNOWN[symbol.toUpperCase()];
  const bg = known?.bg ?? hue(`${symbol}${address ?? ''}`);
  const fg = known?.fg ?? '#08110e';
  const glyph = known?.glyph ?? 'letter';
  const letter = (symbol || '?').slice(0, 1).toUpperCase();
  return (
    <svg className="mark" width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
      <rect width="32" height="32" rx="10" fill={bg} />
      {glyph === 'eth' && <path d="M16 5l7 11-7 4-7-4 7-11zm0 17l7-4-7 9-7-9 7 4z" fill={fg} />}
      {glyph === 'pls' && <path d="M6 20h4.2V11H14v12h4.2V8H22v9h4" stroke={fg} strokeWidth="2.2" fill="none" strokeLinejoin="round" strokeLinecap="round" />}
      {glyph === 'hex' && <path d="M16 6l8 4.6v9.2L16 26l-8-4.6v-9.2L16 6z" fill="none" stroke={fg} strokeWidth="2" />}
      {glyph === 'dai' && <text x="16" y="21" textAnchor="middle" fontSize="15" fontFamily="var(--font)" fill={fg} fontWeight="600">D</text>}
      {glyph === 'usd' && <text x="16" y="21" textAnchor="middle" fontSize="14" fontFamily="var(--font)" fill={fg} fontWeight="600">{letter}</text>}
      {glyph === 'letter' && <text x="16" y="21" textAnchor="middle" fontSize="14" fontFamily="var(--font)" fill={fg} fontWeight="600">{letter}</text>}
    </svg>
  );
}

export function ChainMark({ short, color, size = 28 }: { short: string; color: string; size?: number }) {
  return (
    <svg className="mark" width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
      <rect width="32" height="32" rx="10" fill={color} />
      <text x="16" y="20" textAnchor="middle" fontSize={short.length > 3 ? 8 : 9} fontFamily="ui-monospace, monospace" fill="#04150d" fontWeight="700">{short.slice(0, 4)}</text>
    </svg>
  );
}

export type IconName =
  | 'grid' | 'trend' | 'drop' | 'wallet' | 'layers' | 'spark' | 'chart' | 'search' | 'flask'
  | 'swap' | 'bell' | 'gear' | 'users' | 'book' | 'pulse' | 'user' | 'activity' | 'coins' | 'target' | 'list' | 'home' | 'more';

const STROKE = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const };

const PATHS: Record<IconName, ReactNode> = {
  grid: <path {...STROKE} d="M5 8h14M5 12h14M5 16h14M8 5v14M12 5v14M16 5v14" />,
  trend: <path {...STROKE} d="M4 16l5-5 3 3 8-8M14 6h6v6" />,
  drop: <path {...STROKE} d="M12 4s6 6.2 6 10a6 6 0 0 1-12 0c0-3.8 6-10 6-10z" />,
  wallet: <><rect {...STROKE} x="3" y="6" width="18" height="13" rx="2" /><path {...STROKE} d="M3 10h18M15 14h3" /></>,
  layers: <path {...STROKE} d="M12 4l8 4-8 4-8-4 8-4zm-8 8l8 4 8-4M4 16l8 4 8-4" />,
  spark: <path {...STROKE} d="M12 3l1.6 5.2L19 10l-5.4 1.8L12 17l-1.6-5.2L5 10l5.4-1.8L12 3zM18 15l.7 2.1L21 18l-2.3.7L18 21l-.7-2.3L15 18l2.3-.9L18 15z" />,
  chart: <path {...STROKE} d="M4 19V5M4 19h16M8 15v-4M12 15V8M16 15v-6" />,
  search: <><circle {...STROKE} cx="11" cy="11" r="6" /><path {...STROKE} d="M16 16l4 4" /></>,
  flask: <path {...STROKE} d="M9 3h6M10 3v6L5.5 18a3 3 0 0 0 2.6 4.5h7.8a3 3 0 0 0 2.6-4.5L14 9V3" />,
  swap: <path {...STROKE} d="M7 7h11l-3-3M17 17H6l3 3" />,
  bell: <path {...STROKE} d="M6 16V11a6 6 0 0 1 12 0v5l1.5 2H4.5L6 16zM10 19a2 2 0 0 0 4 0" />,
  gear: <><circle {...STROKE} cx="12" cy="12" r="3" /><path {...STROKE} d="M12 3.5v2.2M12 18.3v2.2M3.5 12h2.2M18.3 12h2.2M6 6l1.6 1.6M16.4 16.4L18 18M18 6l-1.6 1.6M7.6 16.4L6 18" /></>,
  users: <><circle {...STROKE} cx="9" cy="9" r="3" /><path {...STROKE} d="M3.5 19c.6-2.6 2.8-4 5.5-4s4.9 1.4 5.5 4M16 11a2.5 2.5 0 1 0 0-5M17 15c1.8.2 3.2 1.3 3.8 3" /></>,
  book: <path {...STROKE} d="M5 5.5A2.5 2.5 0 0 1 7.5 3H19v16H7.5A2.5 2.5 0 0 0 5 21.5V5.5zM5 19.2A2.5 2.5 0 0 1 7.5 17H19" />,
  pulse: <path {...STROKE} d="M3 12h4l2-5 4 10 2-5h6" />,
  user: <><circle {...STROKE} cx="12" cy="8" r="3" /><path {...STROKE} d="M5 19c1-3 3.2-4.5 7-4.5S18 16 19 19" /></>,
  activity: <path {...STROKE} d="M4 8h4l2 8 3-12 2 8h5" />,
  coins: <><ellipse {...STROKE} cx="12" cy="7" rx="7" ry="3" /><path {...STROKE} d="M5 7v5c0 1.7 3.1 3 7 3s7-1.3 7-3V7M5 12v5c0 1.7 3.1 3 7 3s7-1.3 7-3v-5" /></>,
  target: <><circle {...STROKE} cx="12" cy="12" r="7" /><circle {...STROKE} cx="12" cy="12" r="3" /><path {...STROKE} d="M12 3v2M12 19v2M3 12h2M19 12h2" /></>,
  list: <path {...STROKE} d="M8 7h12M8 12h12M8 17h12M4 7h.01M4 12h.01M4 17h.01" />,
  home: <path {...STROKE} d="M4 11.5 12 4l8 7.5V20a1 1 0 0 1-1 1h-5v-6H10v6H5a1 1 0 0 1-1-1v-8.5z" />,
  more: <><circle cx="6" cy="12" r="1.15" fill="currentColor" /><circle cx="12" cy="12" r="1.15" fill="currentColor" /><circle cx="18" cy="12" r="1.15" fill="currentColor" /></>,
};

export function Icon({ name, size = 20 }: { name: IconName; size?: number }) {
  return (
    <svg className="ico" width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      {PATHS[name]}
    </svg>
  );
}
