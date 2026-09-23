import { describe, expect, it } from 'vitest';
import { generateShortCode, shortCodeDay, shortCodePattern } from '../src/orders/short-code.js';

describe('short order code', () => {
  it('generates four readable characters without ambiguous symbols', () => {
    const code = generateShortCode(Uint8Array.from([0, 1, 2, 3]));
    expect(code).toMatch(new RegExp(shortCodePattern));
    expect(code).not.toMatch(/[01IO]/);
  });

  it('uses the configured campus time zone for the uniqueness day', () => {
    const day = shortCodeDay(new Date('2026-09-21T16:30:00.000Z'), 'Asia/Shanghai');
    expect(day.toISOString()).toBe('2026-09-22T00:00:00.000Z');
  });
});
