import { describe, expect, it } from 'vitest';
import { parseDate, qualificationState, validateTerm } from '../src/riders/eligibility-policy.js';

const term = { startsAt: new Date('2026-09-01T00:00:00Z'), endsAt: new Date('2027-01-01T00:00:00Z') };
const review = { decision: 'APPROVED', validFrom: term.startsAt, validUntil: term.endsAt };
describe('explicit student qualification boundaries', () => {
  it('does not invent student or graduation facts for unknown legacy data', () => {
    expect(qualificationState(null, null, null, false, term.startsAt)).toBe('CALENDAR_UNCONFIGURED');
    expect(qualificationState(null, term, null, false, term.startsAt)).toBe('NONE');
    expect(qualificationState(null, term, null, true, term.startsAt)).toBe('UNDER_REVIEW');
  });
  it('uses half-open validity and verified graduation takes priority', () => {
    expect(qualificationState(null, term, review, false, term.startsAt)).toBe('VALID');
    expect(qualificationState(null, term, review, false, term.endsAt)).toBe('RENEWAL_REQUIRED');
    const graduation = new Date('2026-10-10T00:00:00Z');
    expect(qualificationState({ expectedGraduationAt: graduation }, term, review, true, graduation)).toBe('GRADUATED');
    expect(qualificationState({ expectedGraduationAt: graduation }, term, review, true, new Date(graduation.getTime() - 1))).toBe('VALID');
    expect(qualificationState(null, term, { ...review, decision: 'REJECTED' }, true, term.startsAt)).toBe('REJECTED');
  });
  it('preserves explicit entry time and supports a holiday renewal window', () => {
    expect(qualificationState(null, term, { ...review, validFrom: new Date('2026-10-11T00:00:00Z') }, false, new Date('2026-10-10T00:00:00Z'))).toBe('NOT_YET_VALID');
    const input = { name: 'fixture only', timeZone: 'Asia/Singapore', startsAt: term.startsAt.toISOString(), endsAt: term.endsAt.toISOString(), renewalOpensAt: '2026-08-01T00:00:00+08:00', renewalClosesAt: '2026-08-31T00:00:00+08:00', reminderStartsAt: '2026-07-20T00:00:00+08:00', requestKey: 'test', reason: 'test' };
    expect(validateTerm(input).renewalOpensAt).toEqual(new Date(input.renewalOpensAt));
    expect(() => validateTerm({ ...input, timeZone: 'invalid/timezone' })).toThrow();
    expect(() => validateTerm({ ...input, renewalClosesAt: input.renewalOpensAt })).toThrow();
    expect(() => validateTerm({ ...input, startsAt: input.endsAt })).toThrow();
    expect(() => parseDate('2026-10-10T00:00:00')).toThrow();
    expect(() => parseDate('2026-02-30T00:00:00Z')).toThrow();
  });
});
