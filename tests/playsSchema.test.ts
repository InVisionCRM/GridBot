import { describe, expect, it } from 'vitest';
import { parseCandidate, parseJsonlLine, parsePaperTrade, parseScorekeeperTrade, parseVetted } from '../src/plays/schema';
import { PAPER_TRADE_SCHEMA_VERSION } from '../src/plays/types';
import { T0, WETH, rawCandidate } from './helpers/plays';

const pool = '0x' + 'ab'.repeat(20);
const token = '0x' + '11'.repeat(20);

describe('candidate schema', () => {
  it('accepts a contract row and keeps optional X and launchpad fields', () => {
    const parsed = parseCandidate(rawCandidate({
      pool: WETH.toUpperCase().replace('0X', '0x'),
      xMentions: 12,
      xUniqueAuthors: 4,
      xSentiment: 0.2,
      redFlags: ['proxy'],
      launchpad: 'PumpPill',
      curveProgress: 0.4,
      status: 'new',
      extra: 'ignored',
    }));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.pool).toBe(WETH);
    expect(parsed.value.xMentions).toBe(12);
    expect(parsed.value.redFlags).toEqual(['proxy']);
    expect(parsed.value.launchpad).toBe('PumpPill');
    expect(parsed.value).not.toHaveProperty('extra');
  });

  it('normalizes pool kind and accepts a dynamic fee tier', () => {
    const parsed = parseCandidate(rawCandidate({ poolKind: 'v3', feeTier: 'Dynamic' }));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.poolKind).toBe('V3');
    expect(parsed.value.feeTier).toBe('dynamic');
  });

  it('rejects a raw Uniswap fee() instead of treating it as 0.01%', () => {
    const parsed = parseCandidate(rawCandidate({ feeTier: 10_000 }));
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.errors.map((e) => e.message).join(' ')).toMatch(/0\.01%/);
    expect(parsed.errors.map((e) => e.message).join(' ')).toMatch(/10000 → 100/);
  });

  it('rejects a bad signal, a strength outside 0–1, and a non-address', () => {
    const parsed = parseCandidate(rawCandidate({ signal: 'volume_spike_vs_7d', strength: 1.2, token: 'not-a-token' }));
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    const paths = parsed.errors.map((e) => e.path);
    expect(paths).toContain('signal');
    expect(paths).toContain('strength');
    expect(paths).toContain('token');
  });

  it('does not accept the scout snake_case keys as the contract', () => {
    const row = rawCandidate();
    delete row.id;
    row.candidate_id = 'c1';
    const parsed = parseCandidate(row);
    expect(parsed.ok).toBe(false);
  });

  it('quarantines a bad JSONL line without throwing', () => {
    expect(parseJsonlLine('{', parseCandidate).ok).toBe(false);
    expect(parseJsonlLine('   ', parseCandidate).ok).toBe(false);
    const ok = parseJsonlLine(JSON.stringify(rawCandidate()), parseCandidate);
    expect(ok.ok).toBe(true);
  });
});

describe('vetted schema', () => {
  const camel = {
    candidateId: 'c1',
    t: T0,
    pass: true,
    reasons: ['liquidity locked'],
    sizeUsd: 80,
    maxImpactPct: 0.8,
    stopLossPct: 20,
    tpPct: [40, 80],
    timeStopH: 6,
    taxes: { buy: 0, sell: 0.01, transfer: 0 },
    lpUnlocked: false,
  };

  const legacy = {
    candidate_id: 'c1',
    timestamp: T0,
    status: 'pass',
    reasons: ['liquidity locked'],
    sizing: { size_usd: 80, max_impact_pct: 0.8 },
    exits: { stop_loss_pct: 20, tp_pct: [40, 80], time_stop_h: 6 },
    taxes: { buy: 0, sell: 0.01, transfer: 0 },
    lp_unlocked: true,
    note: 'ignored',
  };

  it('accepts the camelCase contract', () => {
    const parsed = parseVetted(camel);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value).toMatchObject({ candidateId: 'c1', t: T0, pass: true, sizeUsd: 80, lpUnlocked: false });
    expect(parsed.value.tpPct).toEqual([40, 80]);
  });

  it('normalizes the Risk Officer snake_case shape onto the contract', () => {
    const parsed = parseVetted(legacy);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value).toEqual({
      candidateId: 'c1',
      t: T0,
      pass: true,
      reasons: ['liquidity locked'],
      sizeUsd: 80,
      maxImpactPct: 0.8,
      stopLossPct: 20,
      tpPct: [40, 80],
      timeStopH: 6,
      taxes: { buy: 0, sell: 0.01, transfer: 0 },
      lpUnlocked: true,
    });
  });

  it('accepts epoch seconds, an ISO timestamp, a single reason and a single target', () => {
    const parsed = parseVetted({
      ...legacy,
      timestamp: T0 / 1000,
      status: 'approved',
      reason: 'ok',
      reasons: undefined,
      exits: { stop_loss_pct: 20, tp_pct: 40, time_stop_h: 6 },
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.t).toBe(T0);
    expect(parsed.value.pass).toBe(true);
    expect(parsed.value.reasons).toEqual(['ok']);
    expect(parsed.value.tpPct).toEqual([40]);
  });

  it('parses an ISO timestamp', () => {
    const parsed = parseVetted({ ...legacy, timestamp: '2026-10-27T20:00:00.000Z' });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.t).toBe(Date.parse('2026-10-27T20:00:00.000Z'));
  });

  it('maps a failing status to pass false, and rejects an unknown status or a disagreement', () => {
    const failed = parseVetted({ ...legacy, status: 'rejected' });
    expect(failed.ok).toBe(true);
    if (failed.ok) expect(failed.value.pass).toBe(false);

    const unknown = parseVetted({ ...legacy, status: 'maybe' });
    expect(unknown.ok).toBe(false);

    const clash = parseVetted({ ...legacy, pass: true, status: 'fail' });
    expect(clash.ok).toBe(false);
    if (!clash.ok) expect(clash.errors.some((e) => /disagree/.test(e.message))).toBe(true);
  });

  it('rejects disagreeing sizes and taxes written as percents', () => {
    const clash = parseVetted({ ...camel, sizing: { size_usd: 10 } });
    expect(clash.ok).toBe(false);
    if (!clash.ok) expect(clash.errors.some((e) => e.path === 'sizeUsd' && /disagree/.test(e.message))).toBe(true);

    const taxes = parseVetted({ ...camel, taxes: { buy: 0, sell: 3, transfer: 0 } });
    expect(taxes.ok).toBe(false);
    if (!taxes.ok) expect(taxes.errors.map((e) => e.message).join(' ')).toMatch(/fraction/);
  });
});

describe('paper-trade schema', () => {
  const buy = {
    id: 'pl-c1-1',
    candidateId: 'c1',
    t: T0,
    side: 'buy',
    price: 0.0000412,
    tokens: 1_203_398.1,
    costs: { swapFee: 0.5, gasNative: 0.0000031, tax: 0, impact: 0.004 },
    exitReason: null,
    netTokens: -50.01,
  };

  it('accepts the contract fill', () => {
    const parsed = parsePaperTrade(buy);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.exitReason).toBeNull();
    expect(parsed.value.netTokens).toBe(-50.01);
  });

  it('rejects a buy that carries an exit reason', () => {
    const parsed = parsePaperTrade({ ...buy, exitReason: 'stop_loss' });
    expect(parsed.ok).toBe(false);
  });

  it('accepts Scorekeeper columns in camelCase or snake_case and requires the full set', () => {
    const score = {
      ...buy,
      side: 'sell',
      exitReason: 'stop_loss',
      netTokens: 47.88,
      play_id: 'pl-c1',
      signal_type: 'momentum',
      source: 'uniswap-v3-quoter',
      token,
      pool,
      entry_timestamp: T0,
      exit_ts: T0 + 3_600_000,
      fee_tier_entry: 100,
      feeTierExit: 'dynamic',
      impact_entry: 0.004,
      impact_exit: 0.005,
      gas_used: 180_000,
      gas_price: 1_000_000,
      size_spent: 0.02,
      target_pct: 50,
      stop_pct: 25,
      sell_tax_taken: 0.01,
      schema_version: PAPER_TRADE_SCHEMA_VERSION,
    };
    const parsed = parseScorekeeperTrade(score);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.playId).toBe('pl-c1');
    expect(parsed.value.signalType).toBe('momentum');
    expect(parsed.value.token).toBe(token);
    expect(parsed.value.feeTierEntry).toBe(100);
    expect(parsed.value.feeTierExit).toBe('dynamic');
    expect(parsed.value.entryTs).toBe(T0);
    expect(parsed.value.schemaVersion).toBe(1);

    const partial = parsePaperTrade({ ...buy, play_id: 'pl-c1' });
    expect(partial.ok).toBe(true);
    expect(parseScorekeeperTrade({ ...buy, play_id: 'pl-c1' }).ok).toBe(false);

    const backwards = parseScorekeeperTrade({ ...score, exit_ts: T0 - 1 });
    expect(backwards.ok).toBe(false);
  });

  it('accepts a take-profit rung reason', () => {
    const parsed = parsePaperTrade({ ...buy, side: 'sell', exitReason: 'tp_1', netTokens: 10 });
    expect(parsed.ok).toBe(true);
  });
});
