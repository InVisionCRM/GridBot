/** More (Kyle 2026-10-30, Coinbase style): eight tiles, each with a live figure; the Wallet tile is the wallet's dust-free total. */
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { More } from '../src/ui/More';
import { usd } from '../src/ui/fmt';
import { HOLDINGS, S } from './helpers/unitsScreens';

const noop = () => {};
const page = (holdings: unknown) => renderToStaticMarkup(h(More, { s: S, nav: noop, holdings: holdings as never, onGuide: noop }));

describe('More', () => {
  it('eight tiles, in order', () => {
    const labels = [...page(HOLDINGS).matchAll(/class="mo-label">([^<]*)</g)].map((m) => m[1]);
    expect(labels).toEqual(['Wallet', 'Auto traders', 'Opportunities', 'Alerts', 'History', 'System', 'Charts & tools', 'Settings']);
  });
  it('the Wallet tile is the wallet\'s dust-free total; with no key it says paper', () => {
    expect(/class="mo-value">([^<]*)</.exec(page(HOLDINGS))![1]).toBe(usd(HOLDINGS.netWorthExDustUsd));
    expect(/class="mo-value">([^<]*)</.exec(page({ hasSigner: false }))![1]).toBe('Paper');
  });
});
