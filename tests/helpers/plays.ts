import { chainById } from '../../src/live/chains';
import type { IntakeCosts, IntakeRequest, PlayHistory } from '../../src/plays/intake';
import { freshPlaysControl, freshPlaysOptions, type PlaysControl } from '../../src/plays/options';
import type { Candidate, Vetted } from '../../src/plays/types';

const hood = chainById(4663);
if (!hood) throw new Error('Robinhood Chain is missing from the registry');

export const WETH = hood.wrappedNative.address.toLowerCase();
export const USDG = hood.stables[0].address.toLowerCase();

export const T0 = 1_793_136_000_000;

export function candidate(over: Partial<Candidate> = {}): Candidate {
  return {
    id: 'c1',
    t: T0,
    chainId: 4663,
    pool: '0x' + 'ab'.repeat(20),
    dex: 'uniswap-v3',
    token: '0x' + '11'.repeat(20),
    quote: WETH,
    signal: 'momentum',
    strength: 0.8,
    priceAtFlag: 0.00004,
    priceSource: 'uniswap-v3-quoter',
    liqUsd: 80_000,
    vol24hUsd: 20_000,
    poolAgeH: 48,
    thesis: 'volume expanded after a higher low',
    feeTier: 100,
    poolKind: 'V3',
    redFlags: [],
    ...over,
  };
}

export function vetted(over: Partial<Vetted> = {}): Vetted {
  return {
    candidateId: 'c1',
    t: T0,
    pass: true,
    reasons: ['liquidity locked'],
    sizeUsd: 100,
    maxImpactPct: 1,
    stopLossPct: 25,
    tpPct: [50, 100],
    timeStopH: 6,
    taxes: { buy: 0, sell: 0, transfer: 0 },
    ...over,
  };
}

export function costs(over: Partial<IntakeCosts> = {}): IntakeCosts {
  return {
    entryTier: 100,
    exitTier: 100,
    impactEntry: 0,
    impactExit: 0,
    gasQuoteEntry: 0,
    gasQuoteExit: 0,
    size: 100,
    ...over,
  };
}

export function history(over: Partial<PlayHistory> = {}): PlayHistory {
  return { usedCandidateIds: [], openTokens: [], openCount: 0, losingExitsToday: 0, ...over };
}

export function openRequest(over: Partial<IntakeRequest> = {}): IntakeRequest {
  const options = over.options ?? freshPlaysOptions();
  const control: PlaysControl = over.control ?? freshPlaysControl({ on: true });
  return {
    candidate: candidate(),
    vetted: vetted(),
    now: T0,
    control,
    options,
    history: history(),
    costs: costs(),
    ...over,
  };
}

export function rawCandidate(over: Record<string, unknown> = {}): Record<string, unknown> {
  const c = candidate();
  return { ...c, ...over };
}
