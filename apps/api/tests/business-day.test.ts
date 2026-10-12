import { describe, expect, it } from 'vitest';
import * as time from '../src/shared/time.js';

describe('local merchant business day intervals', () => {
  it('switches at local 04:00, preserving the prior day across midnight', () => {
    for (const now of ['2026-10-11T16:00:00Z', '2026-10-11T19:59:59.999Z']) {
      expect(time.businessDayInterval(new Date(now), 'Asia/Shanghai', '04:00')).toEqual({
        day: '2026-10-11', startsAt: new Date('2026-10-10T20:00:00Z'), nextStartsAt: new Date('2026-10-11T20:00:00Z'),
      });
    }
    expect(time.businessDayInterval(new Date('2026-10-11T20:00:00Z'), 'Asia/Shanghai', '04:00')).toEqual({
      day: '2026-10-12', startsAt: new Date('2026-10-11T20:00:00Z'), nextStartsAt: new Date('2026-10-12T20:00:00Z'),
    });
  });
  it('uses IANA local dates, including a UTC date different from the business date', () => {
    expect(time.businessDayInterval(new Date('2026-10-12T03:00:00Z'), 'America/Los_Angeles', '04:00').day).toBe('2026-10-11');
    expect(time.businessDayInterval(new Date('2026-10-11T16:00:00Z'), 'Asia/Shanghai', '00:00').day).toBe('2026-10-12');
    expect(time.businessDayInterval(new Date('2026-12-31T20:00:00Z'), 'Asia/Shanghai', '04:00').day).toBe('2027-01-01');
  });
  it('switches once through DST gaps and repeats (first valid minute and first occurrence)', () => {
    const spring = time.businessDayInterval(new Date('2026-03-08T07:00:00Z'), 'America/New_York', '02:30');
    expect(spring.startsAt).toEqual(new Date('2026-03-08T07:00:00Z'));
    const fall = time.businessDayInterval(new Date('2026-11-01T06:15:00Z'), 'America/New_York', '01:30');
    expect(fall.startsAt).toEqual(new Date('2026-11-01T05:30:00Z'));
    expect(fall.nextStartsAt).toEqual(new Date('2026-11-02T06:30:00Z'));
  });
});
