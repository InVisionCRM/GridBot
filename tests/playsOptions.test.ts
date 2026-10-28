import { describe, expect, it } from 'vitest';
import { chainById } from '../src/live/chains';
import { quoteTokens } from '../src/plays/chainConfig';
import {
  DEFAULT_PLAYS, DEFAULT_PLAYS_CONTROL, LIVE_LIMITS_PROPOSAL, applyStopAll, canExitPlay, canOpenPlay,
  detroitDay, freshPlaysControl, freshPlaysOptions, resumeEntries, sameDetroitDay, sizeRoom, validatePlaysOptions,
} from '../src/plays/options';

describe('plays defaults', () => {
  it('ships off, in paper, on Robinhood Chain, with the stated limits', () => {
    expect(DEFAULT_PLAYS_CONTROL.on).toBe(false);
    expect(DEFAULT_PLAYS_CONTROL.offMode).toBe('exits');
    expect(DEFAULT_PLAYS_CONTROL.entriesHalted).toBe(false);
    expect(DEFAULT_PLAYS.mode).toBe('paper');
    expect(DEFAULT_PLAYS.chains).toEqual([4663]);
    expect(DEFAULT_PLAYS.maxOpen).toBe(3);
    expect(DEFAULT_PLAYS.maxPerPlay).toBe(0.35);
    expect(DEFAULT_PLAYS.reserve).toBe(0.20);
    expect(DEFAULT_PLAYS.maxImpact).toBe(0.01);
    expect(DEFAULT_PLAYS.maxSellTax).toBe(0.03);
    expect(DEFAULT_PLAYS.maxBuySellTax).toBe(0.05);
    expect(DEFAULT_PLAYS.minLiquidityUsd).toBe(50_000);
    expect(DEFAULT_PLAYS.minPoolAgeH).toBe(24);
    expect(DEFAULT_PLAYS.tokenCooldownH).toBe(24);
    expect(DEFAULT_PLAYS.lossCooldownH).toBe(2);
    expect(DEFAULT_PLAYS.maxLosingExitsPerDay).toBe(3);
    expect(DEFAULT_PLAYS.maxRoundTripCost).toBe(0.03);
    expect(DEFAULT_PLAYS.liveLimits).toBeNull();
    expect(DEFAULT_PLAYS.launchpad).toMatchObject({
      on: false, mode: 'paper', paperEth: 0.25, maxOpen: 2, venues: ['PumpPill', 'Arrow'], minLiquidityUsd: 20_000,
    });
    expect(validatePlaysOptions(DEFAULT_PLAYS)).toEqual([]);
  });

  it('leaves live dollar limits unset and does not apply the proposal', () => {
    expect(JSON.stringify(DEFAULT_PLAYS)).not.toContain('perPlayUsd');
    expect(LIVE_LIMITS_PROPOSAL.perPlayUsd).toBe(50);
    const live = freshPlaysOptions();
    live.mode = 'live';
    expect(validatePlaysOptions(live).join(' ')).toMatch(/unset/);
    expect(DEFAULT_PLAYS.mode).toBe('paper');
    expect(DEFAULT_PLAYS.liveLimits).toBeNull();
  });

  it('resolves 4663 quotes from the registry and does not list PancakeSwap', () => {
    const chain = chainById(4663)!;
    const quotes = quoteTokens(4663)!;
    expect(quotes.map((q) => q.symbol)).toEqual(['WETH', 'USDG']);
    expect(quotes[0].address).toBe(chain.wrappedNative.address);
    expect(quotes[1].address).toBe(chain.stables[0].address);
    expect(quotes[0].address).toBe('0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73');
    const options = freshPlaysOptions();
    options.chains = [1];
    expect(validatePlaysOptions(options).join(' ')).toMatch(/not in the plays chain list/);
  });

  it('refuses limits looser than the defaults', () => {
    const loose = freshPlaysOptions();
    loose.maxOpen = 4;
    loose.maxImpact = 0.02;
    loose.minLiquidityUsd = 5_000;
    loose.launchpad.paperEth = 1;
    loose.launchpad.venues = ['Pons' as 'PumpPill'];
    const text = validatePlaysOptions(loose).join(' ');
    expect(text).toMatch(/1 to 3/);
    expect(text).toMatch(/1%/);
    expect(text).toMatch(/\$50,000/);
    expect(text).toMatch(/0\.25 ETH/);
    expect(text).toMatch(/PumpPill and Arrow only/);
  });
});

describe('on/off and Stop all', () => {
  it('keeps entries shut until the switch is on, and Stop all shuts them again', () => {
    const off = freshPlaysControl();
    expect(canOpenPlay(off, 4663)).toBe(false);
    expect(canExitPlay(off)).toBe(true);

    const on = freshPlaysControl({ on: true });
    expect(canOpenPlay(on, 4663)).toBe(true);
    const stopped = applyStopAll(on, null);
    expect(stopped.entriesHalted).toBe(true);
    expect(stopped.haltChains).toBeNull();
    expect(canOpenPlay(stopped, 4663)).toBe(false);
    expect(canExitPlay(stopped)).toBe(true);

    const oneChain = applyStopAll(on, 4663);
    expect(canOpenPlay(oneChain, 1)).toBe(true);
    expect(canOpenPlay(oneChain, 4663)).toBe(false);
    const widened = applyStopAll(oneChain, null);
    expect(widened.haltChains).toBeNull();
    expect(canOpenPlay(resumeEntries(widened), 4663)).toBe(true);
  });

  it('off completely stops exits too', () => {
    const full = freshPlaysControl({ on: true, offMode: 'full' });
    expect(canOpenPlay(full, 4663)).toBe(false);
    expect(canExitPlay(full)).toBe(false);
  });

  it('sizes one play inside the 35% cap and the 20% reserve', () => {
    const options = freshPlaysOptions();
    expect(sizeRoom(1_000, 0, options)).toBeCloseTo(350, 8);
    expect(sizeRoom(1_000, 700, options)).toBeCloseTo(100, 8);
    expect(sizeRoom(1_000, 800, options)).toBe(0);
  });
});

describe('Detroit day', () => {
  it('rolls the calendar at Detroit midnight', () => {
    expect(detroitDay(Date.parse('2026-10-28T03:30:00.000Z'))).toBe('2026-10-27');
    expect(detroitDay(Date.parse('2026-10-28T04:00:00.000Z'))).toBe('2026-10-28');
    expect(sameDetroitDay(Date.parse('2026-10-28T03:30:00.000Z'), Date.parse('2026-10-27T16:00:00.000Z'))).toBe(true);
  });
});
