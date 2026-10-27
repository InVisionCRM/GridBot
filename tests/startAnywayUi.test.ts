import { describe, expect, it } from 'vitest';
import { HttpError, offersStartAnyway } from '../src/ui/api';
import { overrideText } from '../src/ui/haltText';

describe('page: Start anyway is offered only for a check that could not complete', () => {
  it('offersStartAnyway', () => {
    expect(offersStartAnyway(new HttpError('x', 400, { code: 'SAFETY_INCOMPLETE', canStartAnyway: true }))).toBe(true);
    expect(offersStartAnyway(new HttpError('x', 400, { code: 'SAFETY_INCOMPLETE', canStartAnyway: false }))).toBe(false);
    expect(offersStartAnyway(new HttpError('x', 400, { code: 'SAFETY_BLOCKED', canStartAnyway: true }))).toBe(false);
    expect(offersStartAnyway(new HttpError('x', 400, {}))).toBe(false);
    expect(offersStartAnyway(new Error('x'))).toBe(false);
  });
  it('overrideText says who pressed it and why it was blocked (live runs only)', () => {
    const o = { at: 0, what: 'button', detail: 'Start anyway button', origin: 'gateway-owner', blockedBy: 'request timeout' };
    expect(overrideText({ mode: 'live', startOverride: o }, 60_000)).toMatch(/^Started with Start anyway \(Start anyway button from the phone(, [^)]*)?\): the safety check couldn't complete \(request timeout\)\.$/);
    expect(overrideText({ mode: 'paper', startOverride: o })).toBeNull();
    expect(overrideText({ mode: 'live', startOverride: null })).toBeNull();
  });
});
