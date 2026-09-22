import { describe, expect, it } from 'vitest';
import { addMinor, basisPoints, multiplyMinor } from '../src/shared/money.js';

describe('integer money', () => {
  it('uses exact integer arithmetic', () => {
    expect(addMinor(10, 20, 30)).toBe(60);
    expect(multiplyMinor(199, 3)).toBe(597);
    expect(basisPoints(1999, 500)).toBe(99);
  });

  it('rejects fractional and unsafe values', () => {
    expect(() => addMinor(0.1, 0.2)).toThrow(/minor currency units/);
    expect(() => multiplyMinor(Number.MAX_SAFE_INTEGER, 2)).toThrow(/overflowed/);
  });
});

