import { describe, expect, it } from 'vitest';
import { deskRequested } from '../src/uiRoute';

describe('which front end opens', () => {
  it('the classic app is the default; the desk only when asked for', () => {
    expect(deskRequested('')).toBe(false);
    expect(deskRequested('?classic=1')).toBe(false);
    expect(deskRequested('?desk=1')).toBe(true);
    expect(deskRequested('?desk')).toBe(true);
  });
});
