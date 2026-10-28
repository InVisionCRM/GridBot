import { describe, expect, it } from 'vitest';
import { reviewPlay, screenCandidate, sizeForPass } from '../src/plays/intake';
import { freshPlaysOptions } from '../src/plays/options';
import { parseVetted } from '../src/plays/schema';
import { candidate, costs, history, openRequest, vetted } from './helpers/plays';

const open = () => reviewPlay(openRequest());

describe('screen', () => {
  it('skips a rejected status and a V4 pool', () => {
    expect(screenCandidate(candidate({ status: 'rejected', rejectReason: 'thin book' })).code).toBe('rejected');
    expect(screenCandidate(candidate({ status: 'Rejected' })).why).toMatch(/rejected/);
    expect(screenCandidate(candidate({ poolKind: 'V4' })).why).toMatch(/V4/);
  });

  it('blocks severe red flags and lowers the score for the rest', () => {
    for (const flag of ['scam/rug warning', 'honeypot', 'dev dumping', "can't sell", 'cant_sell']) {
      const screened = screenCandidate(candidate({ redFlags: [flag], signal: 'momentum' }));
      expect(screened.code).toBe('red_flag');
    }
    const soft = screenCandidate(candidate({ redFlags: ['proxy', 'mintable'], strength: 0.8 }));
    expect(soft.code).toBeNull();
    expect(soft.score).toBeCloseTo(0.5, 8);
    expect(screenCandidate(candidate({ strength: 0.5, redFlags: ['proxy', 'mintable', 'unlocked', 'young'] })).score).toBe(0);
  });

  it('never lets X fields be the trigger or raise the score', () => {
    const buzz = candidate({
      signal: 'x_buzz', xMentions: 500, xUniqueAuthors: 40, xSentiment: 1, strength: 0.99,
    });
    expect(screenCandidate(buzz).code).toBe('x_only');
    const plain = candidate({ strength: 0.4 });
    const loud = candidate({ strength: 0.4, xMentions: 900, xUniqueAuthors: 80, xSentiment: 1, redFlags: [] });
    expect(screenCandidate(loud).score).toBe(screenCandidate(plain).score);
    expect(screenCandidate(loud).code).toBeNull();
    expect(screenCandidate(candidate({ signal: 'x_buzz', redFlags: ['honeypot'] })).code).toBe('red_flag');
  });
});

describe('review', () => {
  it('opens a vetted pass inside the default limits', () => {
    const decision = open();
    expect(decision.ok).toBe(true);
    expect(decision.code).toBe('open');
    expect(decision.score).toBeCloseTo(0.8, 8);
    expect(decision.sizeUsd).toBe(100);
    expect(decision.paperOnly).toBe(false);
    expect(decision.sizeEth).toBeNull();
  });

  it('joins on candidate id and ignores a miss or a veto', () => {
    expect(reviewPlay(openRequest({ vetted: null })).code).toBe('no_vetted');
    expect(reviewPlay(openRequest({ vetted: vetted({ candidateId: 'other' }) })).code).toBe('id_mismatch');
    expect(reviewPlay(openRequest({ vetted: vetted({ pass: false }) })).code).toBe('veto');
  });

  it('halves a paper pass when liquidity is unlocked and refuses live', () => {
    expect(sizeForPass(vetted({ lpUnlocked: true, sizeUsd: 80 }), 'paper')).toEqual({ ok: true, sizeUsd: 40, paperOnly: true });
    const paper = reviewPlay(openRequest({ vetted: vetted({ lpUnlocked: true, sizeUsd: 80 }) }));
    expect(paper.ok).toBe(true);
    expect(paper.sizeUsd).toBe(40);
    expect(paper.paperOnly).toBe(true);

    const live = freshPlaysOptions();
    live.mode = 'live';
    live.liveLimits = { perPlayUsd: 50, maxOpenUsd: 150, dailyLossUsd: 40, weeklyLossUsd: 100 };
    const refused = reviewPlay(openRequest({ options: live, vetted: vetted({ lpUnlocked: true }) }));
    expect(refused.ok).toBe(false);
    expect(refused.code).toBe('lp_unlocked');
  });

  it('uses a normalized legacy vetted row as the pass', () => {
    const parsed = parseVetted({
      candidate_id: 'c1',
      timestamp: 1_793_136_000,
      status: 'pass',
      reasons: ['lp not locked, paper only'],
      sizing: { size_usd: 80, max_impact_pct: 1 },
      exits: { stop_loss_pct: 20, tp_pct: [40], time_stop_h: 6 },
      taxes: { buy: 0, sell: 0, transfer: 0 },
      lp_unlocked: true,
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const decision = reviewPlay(openRequest({ vetted: parsed.value }));
    expect(decision.ok).toBe(true);
    expect(decision.sizeUsd).toBe(40);
    expect(decision.paperOnly).toBe(true);
  });

  it('enforces chain, dex, quote, age and liquidity', () => {
    expect(reviewPlay(openRequest({ candidate: candidate({ chainId: 1 }) })).code).toBe('chain');
    expect(reviewPlay(openRequest({ candidate: candidate({ dex: 'pancakeswap-v3' }) })).code).toBe('dex');
    expect(reviewPlay(openRequest({ candidate: candidate({ quote: '0x' + '22'.repeat(20) }) })).code).toBe('chain');
    expect(reviewPlay(openRequest({ candidate: candidate({ poolAgeH: 23.9 }) })).code).toBe('pool_age');
    expect(reviewPlay(openRequest({ candidate: candidate({ poolAgeH: 24 }) })).ok).toBe(true);
    expect(reviewPlay(openRequest({ candidate: candidate({ liqUsd: 49_999 }) })).code).toBe('liquidity');
    expect(reviewPlay(openRequest({ candidate: candidate({ liqUsd: 50_000 }) })).ok).toBe(true);
  });

  it('caps sell tax at 3% and buy plus sell at 5%', () => {
    const zeroFee = costs({ entryTier: 0, exitTier: 0 });
    expect(reviewPlay(openRequest({ vetted: vetted({ taxes: { buy: 0, sell: 0.03, transfer: 0 } }), costs: zeroFee })).ok).toBe(true);
    expect(reviewPlay(openRequest({ vetted: vetted({ taxes: { buy: 0, sell: 0.031, transfer: 0 } }), costs: zeroFee })).code).toBe('tax');
    // 5% tax is inside the tax rule and still loses to the 3% round-trip cap.
    expect(reviewPlay(openRequest({ vetted: vetted({ taxes: { buy: 0.02, sell: 0.03, transfer: 0 } }), costs: zeroFee })).code).toBe('cost');
    expect(reviewPlay(openRequest({ vetted: vetted({ taxes: { buy: 0.03, sell: 0.03, transfer: 0 } }) })).code).toBe('tax');
  });

  it('clamps impact down to 1% and never widens a tighter officer cap', () => {
    const tight = reviewPlay(openRequest({
      vetted: vetted({ maxImpactPct: 0.4 }),
      costs: costs({ impactEntry: 0.005, impactExit: 0 }),
    }));
    expect(tight.code).toBe('impact');
    const clamped = reviewPlay(openRequest({
      vetted: vetted({ maxImpactPct: 2 }),
      costs: costs({ impactEntry: 0.002, impactExit: 0.002 }),
    }));
    expect(clamped.ok).toBe(true);
    expect(clamped.impactCap).toBeCloseTo(0.01, 8);
    const over = reviewPlay(openRequest({
      vetted: vetted({ maxImpactPct: 2 }),
      costs: costs({ impactEntry: 0.012, impactExit: 0 }),
    }));
    expect(over.code).toBe('impact');
  });

  it('skips when the round-trip cost is over 3% of size, using the tiers it was given', () => {
    expect(reviewPlay(openRequest({ costs: undefined })).code).toBe('cost');
    const dynamic = reviewPlay(openRequest({ costs: costs({ entryTier: 'dynamic' }) }));
    expect(dynamic.code).toBe('fee_tier');
    expect(dynamic.why).toMatch(/0\.01%/);
    const costly = reviewPlay(openRequest({ costs: costs({ entryTier: 200, exitTier: 200 }) }));
    expect(costly.code).toBe('cost');
    expect(costly.why).toMatch(/3%/);
    const gas = reviewPlay(openRequest({ costs: costs({ gasQuoteEntry: 0.6, gasQuoteExit: 0.6 }) }));
    expect(gas.code).toBe('cost');
    expect(reviewPlay(openRequest({ costs: costs({ entryTier: 100, exitTier: 30 }) })).ok).toBe(true);
  });

  it('applies the per-token cooldowns, the daily pause and the open-play caps', () => {
    const now = 1_793_136_000_000;
    const day = 24 * 3600_000;
    expect(reviewPlay(openRequest({ now, history: history({ lastOpenTs: now - day + 1 }) })).code).toBe('cooldown');
    expect(reviewPlay(openRequest({ now, history: history({ lastOpenTs: now - day }) })).ok).toBe(true);
    expect(reviewPlay(openRequest({ now, history: history({ lastLossExitTs: now - 2 * 3600_000 + 1 }) })).code).toBe('loss_cooldown');
    expect(reviewPlay(openRequest({ now, history: history({ lastLossExitTs: now - 2 * 3600_000 }) })).ok).toBe(true);
    expect(reviewPlay(openRequest({ history: history({ losingExitsToday: 2 }) })).ok).toBe(true);
    expect(reviewPlay(openRequest({ history: history({ losingExitsToday: 3 }) })).code).toBe('day_pause');
    expect(reviewPlay(openRequest({ history: history({ openCount: 3 }) })).code).toBe('max_open');
    expect(reviewPlay(openRequest({ history: history({ openTokens: [candidate().token] }) })).code).toBe('token_open');
    expect(reviewPlay(openRequest({ history: history({ usedCandidateIds: ['c1'] }) })).code).toBe('duplicate');
  });

  it('fits the USD size under the 35% cap and the 20% reserve', () => {
    const book = history({ bookUsd: 1_000, openUsd: 0 });
    expect(reviewPlay(openRequest({ vetted: vetted({ sizeUsd: 400 }), history: book })).sizeUsd).toBeCloseTo(350, 6);
    const crowded = history({ bookUsd: 1_000, openUsd: 700 });
    expect(reviewPlay(openRequest({ vetted: vetted({ sizeUsd: 200 }), history: crowded })).sizeUsd).toBeCloseTo(100, 6);
    expect(reviewPlay(openRequest({ history: history({ bookUsd: 1_000, openUsd: 800 }) })).code).toBe('room');
  });

  it('obeys the plays switch and Stop all', () => {
    expect(reviewPlay(openRequest({ control: { on: false, entriesHalted: false, haltChains: null, offMode: 'exits' } })).code).toBe('switched_off');
    expect(reviewPlay(openRequest({
      control: { on: true, entriesHalted: true, haltChains: null, offMode: 'exits' },
    })).code).toBe('stop_all');
    expect(reviewPlay(openRequest({
      control: { on: true, entriesHalted: true, haltChains: [1], offMode: 'exits' },
    })).ok).toBe(true);
    expect(reviewPlay(openRequest({
      control: { on: true, entriesHalted: true, haltChains: [4663], offMode: 'exits' },
    })).code).toBe('stop_all');
    expect(reviewPlay(openRequest({
      control: { on: true, entriesHalted: false, haltChains: null, offMode: 'full' },
    })).why).toMatch(/completely/);
  });
});

describe('launchpad book', () => {
  function launchpadOptions() {
    const options = freshPlaysOptions();
    options.launchpad.on = true;
    return options;
  }

  it('paper-trades PumpPill and Arrow only, at 0.25 ETH, with its own open cap', () => {
    const row = candidate({ launchpad: 'PumpPill', poolAgeH: 1, liqUsd: 25_000 });
    const decision = reviewPlay(openRequest({ book: 'launchpad', options: launchpadOptions(), candidate: row }));
    expect(decision.ok).toBe(true);
    expect(decision.sizeEth).toBeCloseTo(0.25, 8);
    expect(reviewPlay(openRequest({ book: 'plays', options: launchpadOptions(), candidate: row })).code).toBe('launchpad');
    expect(reviewPlay(openRequest({
      book: 'launchpad', options: launchpadOptions(), candidate: candidate({ launchpad: 'Pons', poolAgeH: 1, liqUsd: 25_000 }),
    })).why).toMatch(/not supported/);
    expect(reviewPlay(openRequest({
      book: 'launchpad', options: launchpadOptions(), candidate: row, history: history({ openCount: 2 }),
    })).code).toBe('max_open');
  });

  it('drops the age rule, uses $20k after migration, and halves the ETH size when liquidity is unlocked', () => {
    const options = launchpadOptions();
    const migrated = candidate({ launchpad: 'Arrow', poolAgeH: 0, liqUsd: 20_000 });
    expect(reviewPlay(openRequest({ book: 'launchpad', options, candidate: migrated })).ok).toBe(true);
    expect(reviewPlay(openRequest({
      book: 'launchpad', options, candidate: candidate({ launchpad: 'Arrow', poolAgeH: 0, liqUsd: 19_999 }),
    })).code).toBe('liquidity');
    const curve = candidate({ launchpad: 'PumpPill', poolAgeH: 0, liqUsd: 1_000, curveProgress: 0.4 });
    expect(reviewPlay(openRequest({ book: 'launchpad', options, candidate: curve })).ok).toBe(true);

    const half = reviewPlay(openRequest({
      book: 'launchpad', options, candidate: migrated, vetted: vetted({ lpUnlocked: true, sizeUsd: 80 }),
    }));
    expect(half.ok).toBe(true);
    expect(half.sizeEth).toBeCloseTo(0.125, 8);
    expect(half.sizeUsd).toBe(40);
  });

  it('keeps its own switch and still stops when Stop all is on', () => {
    const options = freshPlaysOptions();
    const row = candidate({ launchpad: 'PumpPill', poolAgeH: 1, liqUsd: 25_000 });
    expect(reviewPlay(openRequest({
      book: 'launchpad', options, candidate: row, control: { on: true, entriesHalted: false, haltChains: null, offMode: 'exits' },
    })).why).toMatch(/launchpad plays are off/);
    options.launchpad.on = true;
    expect(reviewPlay(openRequest({
      book: 'launchpad', options, candidate: row, control: { on: false, entriesHalted: false, haltChains: null, offMode: 'exits' },
    })).ok).toBe(true);
    expect(reviewPlay(openRequest({
      book: 'launchpad', options, candidate: row, control: { on: false, entriesHalted: true, haltChains: null, offMode: 'exits' },
    })).code).toBe('stop_all');
  });
});
