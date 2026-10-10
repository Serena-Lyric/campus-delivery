import type { AcademicTerm, RiderEligibility, RiderTermQualification } from '@prisma/client';
import { badRequest } from '../shared/errors.js';

export type TermInput = {
  name: string; timeZone: string; startsAt: string; endsAt: string;
  renewalOpensAt: string; renewalClosesAt: string; reminderStartsAt: string;
  requestKey: string; reason: string;
};

export function parseDate(value: string): Date {
  const date = new Date(value);
  const datePart = /^(\d{4}-\d{2}-\d{2})T/.exec(value)?.[1];
  const calendarDate = new Date(`${datePart}T00:00:00Z`);
  if (!Number.isFinite(date.getTime()) || !Number.isFinite(calendarDate.getTime())
    || calendarDate.toISOString().slice(0, 10) !== datePart || !/(Z|[+-]\d{2}:\d{2})$/i.test(value)) {
    throw badRequest('INVALID_ELIGIBILITY_DATE', 'Use an explicit timestamp with a time-zone offset');
  }
  return date;
}

export function validateTerm(input: TermInput) {
  try { new Intl.DateTimeFormat('en', { timeZone: input.timeZone }); }
  catch { throw badRequest('INVALID_TIME_ZONE', 'Use a valid IANA time zone'); }
  const dates = {
    startsAt: parseDate(input.startsAt), endsAt: parseDate(input.endsAt),
    renewalOpensAt: parseDate(input.renewalOpensAt), renewalClosesAt: parseDate(input.renewalClosesAt),
    reminderStartsAt: parseDate(input.reminderStartsAt),
  };
  if (dates.startsAt >= dates.endsAt || dates.renewalOpensAt >= dates.renewalClosesAt
    || dates.reminderStartsAt > dates.renewalOpensAt || dates.renewalClosesAt > dates.endsAt) {
    throw badRequest('INVALID_ACADEMIC_TERM', 'Invalid term, renewal window, or reminder interval');
  }
  return dates;
}

export function qualificationState(
  fact: Pick<RiderEligibility, 'expectedGraduationAt'> | null,
  term: Pick<AcademicTerm, 'startsAt' | 'endsAt'> | null,
  review: Pick<RiderTermQualification, 'decision' | 'validFrom' | 'validUntil'> | null,
  hasApplication: boolean,
  now: Date,
) {
  if (fact?.expectedGraduationAt && now >= fact.expectedGraduationAt) return 'GRADUATED';
  if (!term) return 'CALENDAR_UNCONFIGURED';
  if (review?.decision === 'REJECTED') return 'REJECTED';
  if (review?.decision === 'APPROVED' && review.validFrom && review.validUntil) {
    if (now >= review.validFrom && now < review.validUntil && now >= term.startsAt && now < term.endsAt) return 'VALID';
    return now < review.validFrom ? 'NOT_YET_VALID' : 'RENEWAL_REQUIRED';
  }
  return hasApplication ? 'UNDER_REVIEW' : 'NONE';
}
