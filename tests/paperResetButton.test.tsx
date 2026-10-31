/** The Bots tab offers Reset paper beside the other bulk actions (Kyle, 2026-10-31). */
import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Bots } from '../src/ui/Bots';
import { S } from './helpers/unitsScreens';

describe('Reset paper on the Bots tab', () => {
  it('sits in the bulk actions with Stop all', () => {
    const html = renderToStaticMarkup(createElement(Bots, { s: S, nav: () => undefined, busy: false, onStopAll: () => undefined }));
    expect(html).toMatch(/<p class="foot-links">.*Stop all.*<button type="button">Reset paper<\/button>.*<\/p>/);
  });
});
