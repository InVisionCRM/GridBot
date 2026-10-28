import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = readFileSync('src/v2/desk.css', 'utf8');

describe('v2 layout', () => {
  it('lifts an open breakdown sheet above the tab bar and paints it solid', () => {
    expect(css).toMatch(/\.v2-body:has\(\.sheet-back\)\s*\{[^}]*z-index:\s*30/);
    expect(css).toMatch(/\.v2 \.sheet\.glass\s*\{[^}]*rgba\(22,\s*26,\s*30,\s*1\)/);
    expect(css).toContain('padding-bottom: calc(16px + env(safe-area-inset-bottom, 0px))');
  });

  it('keeps each invested amount with its symbol', () => {
    expect(css).toMatch(/\.v2 \.bag-coin\s*\{[^}]*white-space:\s*nowrap/);
  });

  it('keeps four tab labels on one line', () => {
    expect(css).toMatch(/\.v2 \.tabbar\s*\{[^}]*grid-template-columns:\s*repeat\(4,\s*1fr\)/);
    expect(css).toMatch(/\.v2 \.tabbar button\s*\{[^}]*white-space:\s*nowrap/);
  });
});
