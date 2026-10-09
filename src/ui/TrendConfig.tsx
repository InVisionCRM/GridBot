/** Trend strategy settings editor (New bot + Backtest) and plain-language strategy descriptions. */
import { STRATEGIES, type StrategyKind, type TrendConfig } from '../market/strategy';
import { TFS } from '../market/candles';

export function strategyRule(c: TrendConfig): string {
  const rules: Record<StrategyKind, string> = {
    ema: `the ${c.fast}-candle average crosses above the ${c.slow}-candle average`,
    ema_rsi: `the ${c.fast}/${c.slow} averages cross up while RSI is between ${c.rsiMin} and ${c.rsiMax}`,
    macd: `MACD (${c.macdFast}/${c.macdSlow}) crosses above its ${c.macdSignal}-candle signal line`,
    donchian: `the close beats the highest high of the previous ${c.donchianEntry} candles`,
  };
  return rules[c.strategy];
}

const F = ({ label, children, hint }: { label: string; children: React.ReactNode; hint?: string }) => (
  <label title={hint}>{label}{children}</label>
);

/** Strategy parameters, exits and sizing. `showStrategy` = include the strategy picker. */
export function TrendConfigEditor({ cfg, onChange, showStrategy = true }: { cfg: TrendConfig; onChange: (c: TrendConfig) => void; showStrategy?: boolean }) {
  const set = (k: keyof TrendConfig, isNum = true) => (e: { target: { value: string; checked?: boolean; type?: string } }) =>
    onChange({ ...cfg, [k]: e.target.type === 'checkbox' ? !!e.target.checked : isNum ? Number(e.target.value) : e.target.value });
  const n = (k: keyof TrendConfig, label: string, hint?: string, step = 'any') => (
    <F label={label} hint={hint}><input type="number" step={step} value={cfg[k] as number} onChange={set(k)} /></F>
  );
  return (
    <div className="cfg-editor">
      <div className="form-row">
        {showStrategy && <F label="Strategy"><select value={cfg.strategy} onChange={set('strategy', false)}>{STRATEGIES.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}</select></F>}
        {(cfg.strategy === 'ema' || cfg.strategy === 'ema_rsi') && <>{n('fast', 'Fast average', 'candles', '1')}{n('slow', 'Slow average', 'candles', '1')}</>}
        {cfg.strategy === 'ema_rsi' && <>{n('rsiPeriod', 'RSI length', '', '1')}{n('rsiMin', 'RSI min', 'enter only if RSI ≥ min')}{n('rsiMax', 'RSI max', 'and ≤ max (skips overbought)')}</>}
        {cfg.strategy === 'macd' && <>{n('macdFast', 'MACD fast', '', '1')}{n('macdSlow', 'MACD slow', '', '1')}{n('macdSignal', 'Signal', '', '1')}</>}
        {cfg.strategy === 'donchian' && <>{n('donchianEntry', 'Breakout candles', 'buy when the close beats the prior N-candle high', '1')}{n('donchianExit', 'Exit candles', 'sell when the close drops below the prior N-candle low', '1')}</>}
      </div>
      <div className="form-row">
        {n('stopAtr', 'Stop (× ATR)', 'stop-loss = entry − k × ATR')}
        {n('tpR', 'Take-profit (R)', 'take-profit at entry + R × stop distance; 0 = off')}
        {n('trailAtr', 'Trailing stop (× ATR)', 'trails the highest high by k × ATR; 0 = off')}
        {n('atrPeriod', 'ATR length', '', '1')}
        {n('maxHoldBars', 'Max hold (candles)', '0 = off', '1')}
        {n('cooldownBars', 'Cooldown (candles)', 'candles to wait after an exit', '1')}
      </div>
      <div className="form-row">
        <F label="Position size"><select value={cfg.sizing} onChange={set('sizing', false)}><option value="pct">% of capital</option><option value="risk">risk % per trade</option></select></F>
        {cfg.sizing === 'pct' ? n('sizePct', 'Size %') : n('riskPct', 'Risk %', '% of the bot lost if the stop is hit')}
        {n('minEdgePct', 'Min edge', 'extra expected profit over costs, as a fraction (0.0025 = 0.25%)')}
        {n('expectedMoveAtr', 'Expected move (× ATR)', 'used by the cost check when take-profit is off')}
        <F label="Higher-timeframe filter" hint="only enter when the higher-timeframe close is above its average">
          <span className="inline"><input type="checkbox" checked={cfg.htfEnabled} onChange={set('htfEnabled')} aria-label="use higher-timeframe filter" />
            <select value={cfg.htfTf} onChange={set('htfTf', false)} disabled={!cfg.htfEnabled}>{TFS.map((t) => <option key={t}>{t}</option>)}</select>
            <input type="number" style={{ width: 64 }} value={cfg.htfEma} onChange={set('htfEma')} disabled={!cfg.htfEnabled} aria-label="higher-timeframe average length" /></span>
        </F>
      </div>
    </div>
  );
}
