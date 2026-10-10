import type { Prisma, PrismaClient, AcademicTerm } from '@prisma/client';
import { requireAdminLevel, type Actor } from '../auth/auth.js';
import { badRequest, conflict, notFound } from '../shared/errors.js';
import { requireRider } from './blocklist.js';
import { parseDate, qualificationSnapshot, validateTerm, type TermInput } from './eligibility-policy.js';
import { loadEligibilityGate } from './eligibility-gate.js';

type Db = PrismaClient | Prisma.TransactionClient;
export type RenewalInput = { termId: string; intent: 'CONTINUE' | 'DECLINE' | 'GRADUATE_EXCEPTION'; requestKey: string };
export type ReviewInput = {
  expectedVersion: number; requestKey: string; reason: string; verificationMethod: string;
} & ({ action: 'APPROVE'; termId: string; validFrom: string; validUntil: string }
  | { action: 'REJECT'; termId: string }
  | { action: 'SET_GRADUATION'; expectedGraduationAt: string | null; graduationReminderAt: string | null });

function json(value: unknown): Prisma.InputJsonValue { return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue; }
function same(a: unknown, b: unknown): boolean {
  const canonical = (v: unknown): string => JSON.stringify(v, Object.keys(v as object).sort());
  return canonical(a) === canonical(b);
}
function termDto(term: AcademicTerm) {
  return { id: term.id, name: term.name, timeZone: term.timeZone, startsAt: term.startsAt, endsAt: term.endsAt,
    renewalOpensAt: term.renewalOpensAt, renewalClosesAt: term.renewalClosesAt, reminderStartsAt: term.reminderStartsAt };
}
async function lockRider(tx: Prisma.TransactionClient, riderId: string) {
  const rows = await tx.$queryRaw<Array<{ id: string }>>`SELECT "id" FROM "Rider" WHERE "id" = ${riderId}::uuid FOR UPDATE`;
  if (!rows.length) throw notFound('Rider');
}

export async function createAcademicTerm(prisma: PrismaClient, actor: Actor, input: TermInput) {
  requireAdminLevel(actor, ['SUPER_ADMIN']);
  const dates = validateTerm(input);
  return prisma.$transaction(async (tx) => {
    // One campus calendar in this backend. Serialize even the first configuration.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(17201010)`;
    const prior = await tx.academicTerm.findUnique({ where: { requestKey: input.requestKey } });
    if (prior) {
      const priorInput = { name: prior.name, timeZone: prior.timeZone, reason: prior.reason, requestKey: prior.requestKey,
        ...Object.fromEntries(Object.keys(dates).map((key) => [key, prior[key as keyof typeof dates].toISOString()])) };
      const normalized = { ...input, ...Object.fromEntries(Object.entries(dates).map(([key, date]) => [key, date.toISOString()])) };
      if (prior.createdById !== actor.id || !same(priorInput, normalized)) throw conflict('IDEMPOTENCY_CONFLICT', 'Term request key has different input');
      return termDto(prior);
    }
    const overlap = await tx.academicTerm.findFirst({ where: { OR: [
      { startsAt: { lt: dates.endsAt }, endsAt: { gt: dates.startsAt } },
      { renewalOpensAt: { lt: dates.renewalClosesAt }, renewalClosesAt: { gt: dates.renewalOpensAt } },
    ] } });
    if (overlap) throw conflict('ACADEMIC_TERM_OVERLAP', 'Terms and renewal windows must not overlap');
    return termDto(await tx.academicTerm.create({ data: { ...input, ...dates, createdById: actor.id } }));
  });
}

export async function readEligibility(db: Db, riderId: string, now = new Date()) {
  if (!await db.rider.findUnique({ where: { id: riderId }, select: { id: true } })) throw notFound('Rider');
  const { fact, term, review, state } = await qualificationSnapshot(db, riderId, now);
  const gate = await loadEligibilityGate(db);
  const windows = await db.academicTerm.findMany({
    where: { renewalClosesAt: { gt: now } }, orderBy: { renewalOpensAt: 'asc' }, take: 10,
  });
  const requests = await db.riderRenewalRequest.findMany({ where: { riderId, termId: { in: windows.map((w) => w.id) } },
    select: { id: true, termId: true, intent: true, createdAt: true } });
  const windowReviews = await db.riderTermQualification.findMany({ where: { riderId, termId: { in: windows.map((w) => w.id) } },
    select: { termId: true, decision: true, validFrom: true, validUntil: true, reason: true, reviewedAt: true } });
  const renewalWindows = windows.map((window) => ({ ...termDto(window), canApply: now >= window.renewalOpensAt && now < window.renewalClosesAt,
    reminderDue: now >= window.reminderStartsAt && !requests.some((r) => r.termId === window.id) && !windowReviews.some((r) => r.termId === window.id && r.decision === 'APPROVED'),
    request: requests.find((r) => r.termId === window.id) ?? null,
    qualification: windowReviews.find((r) => r.termId === window.id) ?? null }));
  return {
    state, version: fact?.version ?? 0, evaluatedAt: now, term: term ? termDto(term) : null,
    expectedGraduationAt: fact?.expectedGraduationAt ?? null,
    graduationReminderDue: !!fact?.graduationReminderAt && now >= fact.graduationReminderAt,
    qualification: review ? { decision: review.decision, validFrom: review.validFrom, validUntil: review.validUntil,
      reason: review.reason, reviewedAt: review.reviewedAt } : null,
    renewalWindows,
    nextAction: state === 'VALID' ? 'CHECK_RENEWAL_REMINDERS' : state === 'GRADUATED' ? 'EXCEPTION_STANDARDS_PENDING'
      : state === 'CALENDAR_UNCONFIGURED' ? 'CONTACT_ADMIN_FOR_CALENDAR' : state === 'UNDER_REVIEW' ? 'AWAIT_ADMIN_REVIEW' : 'REQUEST_TERM_REVIEW',
    claimGateEnforced: gate.enforced, enforcementConfigVersion: gate.version,
    qualificationAllowsNewClaims: state === 'VALID',
    transition: gate.enforced ? 'ENFORCED' : 'UNENFORCED_PENDING_ADMIN_CONFIGURATION',
  };
}

export async function getMyEligibility(prisma: PrismaClient, actor: Actor, now = new Date()) {
  const riderId = requireRider(actor);
  return prisma.$transaction((tx) => readEligibility(tx, riderId, now), { isolationLevel: 'RepeatableRead' });
}

export async function submitRenewal(prisma: PrismaClient, actor: Actor, input: RenewalInput, now = new Date()) {
  const riderId = requireRider(actor);
  return prisma.$transaction(async (tx) => {
    await lockRider(tx, riderId);
    const byKey = await tx.riderRenewalRequest.findUnique({ where: { riderId_requestKey: { riderId, requestKey: input.requestKey } } });
    const byTerm = await tx.riderRenewalRequest.findUnique({ where: { riderId_termId: { riderId, termId: input.termId } } });
    const prior = byKey ?? byTerm;
    if (prior) {
      if (prior.termId !== input.termId || prior.intent !== input.intent) throw conflict('IDEMPOTENCY_CONFLICT', 'A different renewal intent has already been recorded');
      return { id: prior.id, termId: prior.termId, intent: prior.intent, createdAt: prior.createdAt };
    }
    const term = await tx.academicTerm.findUnique({ where: { id: input.termId } });
    if (!term) throw notFound('Academic term');
    if (input.intent !== 'GRADUATE_EXCEPTION' && (now < term.renewalOpensAt || now >= term.renewalClosesAt)) {
      throw conflict('RENEWAL_WINDOW_CLOSED', 'Apply during the configured renewal window');
    }
    if (input.intent === 'GRADUATE_EXCEPTION') {
      const fact = await tx.riderEligibility.findUnique({ where: { riderId } });
      if (!fact?.expectedGraduationAt || now < fact.expectedGraduationAt) throw conflict('GRADUATION_NOT_EFFECTIVE', 'No confirmed effective graduation fact');
    }
    const created = await tx.riderRenewalRequest.create({ data: { riderId, ...input, createdAt: now } });
    return { id: created.id, termId: created.termId, intent: created.intent, createdAt: created.createdAt };
  });
}

export async function reviewEligibility(prisma: PrismaClient, actor: Actor, riderId: string, input: ReviewInput, now = new Date()) {
  requireAdminLevel(actor, ['SUPER_ADMIN']);
  if (!input.verificationMethod?.trim()) throw badRequest('VERIFICATION_METHOD_REQUIRED', 'Record the actual manual verification method');
  return prisma.$transaction(async (tx) => {
    await lockRider(tx, riderId);
    const prior = await tx.riderEligibilityReview.findUnique({ where: { riderId_requestKey: { riderId, requestKey: input.requestKey } } });
    if (prior) {
      if (prior.actorId !== actor.id || !same(prior.request, input)) throw conflict('IDEMPOTENCY_CONFLICT', 'Review request key has different input');
      return { id: prior.id, version: prior.version, result: prior.after };
    }
    const fact = await tx.riderEligibility.findUnique({ where: { riderId } });
    if ((fact?.version ?? 0) !== input.expectedVersion) throw conflict('ELIGIBILITY_VERSION_CONFLICT', 'Refresh qualification before reviewing');
    let dates: { expectedGraduationAt?: Date | null; graduationReminderAt?: Date | null } = {};
    let termReview = null;
    if (input.action === 'SET_GRADUATION') {
      const graduation = input.expectedGraduationAt === null ? null : parseDate(input.expectedGraduationAt);
      const reminder = input.graduationReminderAt === null ? null : parseDate(input.graduationReminderAt);
      if (!!graduation !== !!reminder || (graduation && reminder && reminder > graduation)) {
        throw badRequest('INVALID_GRADUATION_REMINDER', 'A graduation fact requires an explicit reminder at or before graduation');
      }
      dates = { expectedGraduationAt: graduation, graduationReminderAt: reminder };
    } else {
      const term = await tx.academicTerm.findUnique({ where: { id: input.termId } });
      if (!term) throw notFound('Academic term');
      termReview = await tx.riderTermQualification.findUnique({ where: { riderId_termId: { riderId, termId: input.termId } } });
      let validFrom = null, validUntil = null;
      if (input.action === 'APPROVE') {
        validFrom = parseDate(input.validFrom); validUntil = parseDate(input.validUntil);
        if (validFrom >= validUntil || validFrom < term.startsAt || validUntil > term.endsAt) {
          throw badRequest('INVALID_QUALIFICATION_INTERVAL', 'Qualification must be within the configured term');
        }
        if (fact?.expectedGraduationAt && (now >= fact.expectedGraduationAt || validUntil > fact.expectedGraduationAt)) {
          throw conflict('GRADUATE_EXCEPTION_NOT_DEFINED', 'Normal review cannot approve delivery after confirmed graduation');
        }
      }
      await tx.riderTermQualification.upsert({ where: { riderId_termId: { riderId, termId: input.termId } },
        create: { riderId, termId: input.termId, decision: input.action === 'APPROVE' ? 'APPROVED' : 'REJECTED', validFrom, validUntil, reason: input.reason, reviewedAt: now },
        update: { decision: input.action === 'APPROVE' ? 'APPROVED' : 'REJECTED', validFrom, validUntil, reason: input.reason, reviewedAt: now } });
    }
    const next = await tx.riderEligibility.upsert({ where: { riderId },
      create: { riderId, version: 1, ...dates }, update: { version: { increment: 1 }, ...dates } });
    const nextReview = input.action === 'SET_GRADUATION' ? null : await tx.riderTermQualification.findUnique({ where: { riderId_termId: { riderId, termId: input.termId } } });
    const audit = await tx.riderEligibilityReview.create({ data: {
      riderId, actorId: actor.id, termId: input.action === 'SET_GRADUATION' ? null : input.termId,
      requestKey: input.requestKey, action: input.action, version: next.version, request: json(input),
      before: json({ fact, termReview }), after: json({ fact: next, termReview: nextReview }), createdAt: now,
    } });
    return { id: audit.id, version: audit.version, result: audit.after };
  });
}

export async function getAdminEligibility(prisma: PrismaClient, actor: Actor, riderId: string) {
  requireAdminLevel(actor, ['SUPER_ADMIN']);
  return prisma.$transaction(async (tx) => ({
    eligibility: await readEligibility(tx, riderId),
    qualifications: await tx.riderTermQualification.findMany({ where: { riderId }, select: { termId: true, decision: true, validFrom: true, validUntil: true, reason: true, reviewedAt: true } }),
    requests: await tx.riderRenewalRequest.findMany({ where: { riderId }, select: { id: true, termId: true, intent: true, createdAt: true }, orderBy: { createdAt: 'desc' }, take: 100 }),
    history: await tx.riderEligibilityReview.findMany({ where: { riderId }, select: { id: true, termId: true, actorId: true, action: true, version: true, request: true, before: true, after: true, createdAt: true }, orderBy: { version: 'desc' }, take: 100 }),
  }), { isolationLevel: 'RepeatableRead' });
}

export async function listAcademicTerms(prisma: PrismaClient, actor: Actor) {
  requireAdminLevel(actor, ['SUPER_ADMIN']);
  const terms = await prisma.academicTerm.findMany({ orderBy: { startsAt: 'desc' }, take: 100 });
  return terms.map((term) => ({ ...termDto(term), createdById: term.createdById, reason: term.reason, createdAt: term.createdAt }));
}
