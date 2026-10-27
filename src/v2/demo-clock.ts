/**
 * Demo server clock. Emits deltas only.
 * Dollars made is recomputed here with settle(), never in a view.
 * DEMO DATA.
 */
import { portfolioOf, settle, snapshotOf, buildState, type DeskState } from './demo-book';
import type { ActivityItem, BotDesk, DeskDelta, DeskSnapshot } from './metrics';

const round = (n: number) => Math.round(n * 100) / 100;

function bumpCandle(bot: BotDesk, price: number) {
  const last = bot.candles[bot.candles.length - 1];
  if (!last) return;
  const step = bot.candles.length > 1 ? last.t - bot.candles[bot.candles.length - 2].t : 60;
  const now = Math.floor(Date.now() / 1000 / step) * step;
  if (now > last.t) {
    bot.candles.push({ t: now, o: last.c, h: Math.max(last.c, price), l: Math.min(last.c, price), c: price, v: 1 });
    if (bot.candles.length > 120) bot.candles.shift();
  } else {
    last.h = Math.max(last.h, price);
    last.l = Math.min(last.l, price);
    last.c = price;
  }
  bot.price = price;
}

function remember(bot: BotDesk) {
  bot.spark = [...bot.spark.slice(-47), bot.metrics.dollarsMadeUsd];
}

export function createDesk() {
  const state: DeskState = buildState();
  let n = 0;
  let seq = 10;

  const hot = () => state.bots.filter((b) => {
    const m = b.metrics;
    if (m.mode !== 'live' || m.status !== 'running') return false;
    if (m.kind === 'lp' && m.range && !m.range.inRange) return false;
    return true;
  });

  return {
    snapshot(): DeskSnapshot {
      return snapshotOf(state);
    },
    tick(): DeskDelta {
      n += 1;
      const pool = hot();
      const bot = pool[n % pool.length];
      const m = bot.metrics;
      const asOf = Date.now();
      m.ageSec += 1;
      m.asOf = asOf;
      let activity: ActivityItem | null = null;
      bot.flashLevel = null;

      if (m.kind === 'lp') {
        const fee = 0.12;
        m.feesUncollectedUsd = round(m.feesUncollectedUsd + fee);
        state.feesTodayLiveUsd = round(state.feesTodayLiveUsd + fee);
        if (n % 5 === 0) {
          activity = { id: `e${seq++}`, t: asOf, botId: m.botId, pair: bot.pair, kind: 'fee', text: `${bot.pair} fees accrued`, tone: 'up' };
        }
      } else {
        m.realizedUsd = round(m.realizedUsd + 0.22);
        m.gasUsd = round(m.gasUsd + 0.01);
        if (m.kind === 'grid' && n % 4 === 0) {
          const level = bot.levels[n % bot.levels.length] ?? bot.price;
          bot.flashLevel = level;
          m.fillCount += 1;
          const barT = bot.candles[bot.candles.length - 1]?.t ?? Math.floor(asOf / 1000);
          bot.fills = [...bot.fills.slice(-12), { id: `f${seq}`, t: barT, price: level, side: n % 8 === 0 ? 'buy' : 'sell' }];
          activity = { id: `e${seq++}`, t: asOf, botId: m.botId, pair: bot.pair, kind: 'fill', text: `${bot.pair} grid filled`, tone: 'up' };
        } else if (n % 6 === 0) {
          activity = { id: `e${seq++}`, t: asOf, botId: m.botId, pair: bot.pair, kind: 'fee', text: `${bot.pair} trade profit booked`, tone: 'up' };
        }
      }

      if (m.range && m.range.inRange) {
        const span = m.range.upper - m.range.lower;
        const mid = bot.tone === 'near' ? 0.86 : 0.42 + 0.08 * Math.sin(n / 3);
        const current = m.range.lower + span * mid;
        m.range = { ...m.range, current };
        bumpCandle(bot, current);
      } else {
        bumpCandle(bot, bot.price * (1 + Math.sin(n / 5) * 0.0004));
      }

      bot.metrics = settle(m);
      remember(bot);
      if (activity) state.activity = [activity, ...state.activity].slice(0, 40);
      const made = portfolioOf(state).dollarsMadeUsd;
      state.madeSeries = [...state.madeSeries.slice(-63), made];

      const fresh = new Set<string>([bot.metrics.botId]);
      return {
        asOf,
        portfolio: portfolioOf(state),
        bots: snapshotOf({ ...state, bots: state.bots.filter((b) => fresh.has(b.metrics.botId)) }).bots,
        prices: state.bots.map((b) => ({ symbol: b.pair, price: b.price, change24h: b.change24h })),
        activity: activity ? [activity] : [],
      };
    },
  };
}
