import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { demoPolicy, seedDatabase, seedIds } from '../../prisma/seed.js';
import { createAcademicTerm, getMyEligibility, reviewEligibility, submitRenewal, type ReviewInput } from '../../src/riders/eligibility.js';
import type { TermInput } from '../../src/riders/eligibility-policy.js';
import { releaseExpiredCoolingOrders } from '../../src/orders/lifecycle.js';
import { claimTask } from '../../src/delivery/service.js';
import { merchantPickup } from './pickup-helper.js';
import { updateBusinessConfig } from '../../src/admin/config-service.js';
import { eligibilityPolicyKey } from '../../src/riders/eligibility-gate.js';

const prisma = new PrismaClient();
const config = { databaseUrl: process.env.DATABASE_URL!, host: '127.0.0.1', port: 3000, enableDevAuth: true, enableBackgroundJobs: false, backgroundSweepIntervalMs: 5000, campusTimeZone: 'Asia/Singapore', logLevel: 'silent' };
const admin = { id: seedIds.admin, role: 'ADMIN' as const, adminLevel: 'SUPER_ADMIN' as const };
const rider = { id: seedIds.riderAUser, role: 'RIDER' as const, riderId: seedIds.riderA };
const headers = (id: string) => ({ 'x-user-id': id });
const now = new Date();
const at = (days: number) => new Date(now.getTime() + days * 86400000).toISOString();
const termInput = (): TermInput => ({ name: 'EXPLICIT TEST FIXTURE, NOT SCHOOL CALENDAR', timeZone: 'Asia/Singapore', startsAt: at(-30), endsAt: at(90), renewalOpensAt: at(-40), renewalClosesAt: at(10), reminderStartsAt: at(-45), requestKey: randomUUID(), reason: 'Test calendar only' });
const approval = (termId: string, expectedVersion = 0): ReviewInput => ({ action: 'APPROVE', termId, expectedVersion, requestKey: randomUUID(), reason: 'Fixture: trusted manual verification of enrolled student', verificationMethod: 'Fixture student card checked in person', validFrom: at(-30), validUntil: at(90) });

async function clearEligibility() {
  await prisma.businessConfigAudit.deleteMany({ where: { key: eligibilityPolicyKey } });
  await prisma.businessConfig.deleteMany({ where: { key: eligibilityPolicyKey } });
  await prisma.riderEligibilityReview.deleteMany();
  await prisma.riderRenewalRequest.deleteMany();
  await prisma.riderTermQualification.deleteMany();
  await prisma.riderEligibility.deleteMany();
  await prisma.academicTerm.deleteMany();
}

describe('student qualification facts and semester review APIs', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  beforeAll(async () => { await seedDatabase(prisma); app = await buildApp(config, prisma); await app.ready(); });
  afterAll(async () => { await clearEligibility(); await app.close(); await prisma.$disconnect(); });
  beforeEach(async () => {
    await clearEligibility();
    await prisma.compensationAllocation.deleteMany(); await prisma.compensationObligation.deleteMany();
    await prisma.remakeProposal.deleteMany(); await prisma.exceptionCaseAction.deleteMany(); await prisma.exceptionCase.deleteMany();
    await prisma.riderRestrictionAudit.deleteMany(); await prisma.riderRestriction.deleteMany(); await prisma.riderCancellationEvent.deleteMany();
    await prisma.merchantExposureDecision.deleteMany(); await prisma.subsidyRecord.deleteMany();
    await prisma.deliveryTask.deleteMany(); await prisma.order.deleteMany(); await prisma.riderBlockedMerchant.deleteMany();
    await prisma.businessConfigAudit.deleteMany();
    await prisma.businessConfig.deleteMany({ where: { id: { not: seedIds.policyConfig } } });
    await prisma.businessConfig.update({ where: { id: seedIds.policyConfig }, data: { payload: demoPolicy, isActive: true } });
    await prisma.merchant.update({ where: { id: seedIds.merchant }, data: { exposureState: 'NORMAL', pickupVerificationMode: 'CONFIRMATION' } });
    await prisma.product.update({ where: { id: seedIds.productRice }, data: { deliveryCategoryCode: 'ORDINARY_MEAL', priceMinor: 1500 } });
    await prisma.rider.updateMany({ data: { status: 'AVAILABLE', capacityOverride: 10 } });
  });
  async function ready() {
    const created = await app.inject({ method: 'POST', url: '/orders', headers: headers(seedIds.customer), payload: { merchantId: seedIds.merchant, destinationLocationId: seedIds.dormLocation, deliveryMethod: 'DESIGNATED_POINT', items: [{ productId: seedIds.productRice, quantity: 1 }] } });
    expect(created.statusCode, created.body).toBe(201);
    const orderId = created.json().id as string;
    await prisma.order.update({ where: { id: orderId }, data: { coolingOffEndsAt: new Date(Date.now() - 1000) } });
    await releaseExpiredCoolingOrders(prisma);
    const response = await app.inject({ method: 'POST', url: `/merchant/orders/${orderId}/confirm`, headers: headers(seedIds.merchantUser) });
    expect(response.statusCode, response.body).toBe(200);
    return { orderId, taskId: response.json().deliveryTask.id as string };
  }
  const claim = (taskId: string) => app.inject({ method: 'POST', url: `/delivery-tasks/${taskId}/claim`, headers: headers(rider.id) });
  const available = () => app.inject({ method: 'GET', url: '/delivery-tasks/available', headers: headers(rider.id) });
  const enableGate = () => updateBusinessConfig(prisma, admin, eligibilityPolicyKey, { enforced: true }, 'Fixture explicit activation', 0);

  it('keeps legacy facts unknown and seed does not fabricate approval or graduation', async () => {
    const result = await getMyEligibility(prisma, rider, now);
    expect(result).toMatchObject({ state: 'CALENDAR_UNCONFIGURED', expectedGraduationAt: null, version: 0, claimGateEnforced: false });
    const term = await createAcademicTerm(prisma, admin, termInput());
    expect((await getMyEligibility(prisma, rider, now)).state).toBe('NONE');
    await seedDatabase(prisma);
    expect(await prisma.riderEligibility.count()).toBe(0);
    expect(await prisma.riderTermQualification.count()).toBe(0);
    expect(await prisma.academicTerm.count({ where: { id: term.id } })).toBe(1);
  });

  it('enforces administrator-only calendar and review routes, and self-only rider information', async () => {
    const input = termInput();
    for (const id of [seedIds.operator, seedIds.riderAUser, seedIds.merchantUser, seedIds.customer]) {
      expect((await app.inject({ method: 'POST', url: '/admin/academic-terms', headers: headers(id), payload: input })).statusCode).toBe(403);
      expect((await app.inject({ method: 'GET', url: `/admin/riders/${seedIds.riderA}/eligibility`, headers: headers(id) })).statusCode).toBe(403);
    }
    const termResponse = await app.inject({ method: 'POST', url: '/admin/academic-terms', headers: headers(seedIds.admin), payload: input });
    expect(termResponse.statusCode, termResponse.body).toBe(201);
    const termId = termResponse.json().id as string;
    for (const id of [seedIds.operator, seedIds.riderAUser, seedIds.merchantUser, seedIds.customer]) {
      expect((await app.inject({ method: 'POST', url: `/admin/riders/${seedIds.riderA}/eligibility/reviews`, headers: headers(id), payload: approval(termId) })).statusCode).toBe(403);
    }
    const response = await app.inject({ method: 'POST', url: `/admin/riders/${seedIds.riderA}/eligibility/reviews`, headers: headers(seedIds.admin), payload: approval(termId) });
    expect(response.statusCode, response.body).toBe(200);
    const own = await app.inject({ method: 'GET', url: '/riders/me/eligibility', headers: headers(seedIds.riderAUser) });
    expect(own.json().state).toBe('VALID');
    for (const privateField of ['actorId', 'createdById', 'riderId', 'userId', 'requestKey', 'history', 'before', 'after']) expect(own.body).not.toContain(`"${privateField}"`);
    const other = await app.inject({ method: 'GET', url: '/riders/me/eligibility', headers: headers(seedIds.riderBUser) });
    expect(other.json()).toMatchObject({ state: 'NONE', qualification: null });
    expect((await app.inject({ method: 'GET', url: '/riders/me/eligibility', headers: headers(seedIds.merchantUser) })).statusCode).toBe(403);
    const forged = await app.inject({ method: 'POST', url: '/riders/me/renewal-requests', headers: headers(seedIds.riderBUser), payload: { termId, requestKey: randomUUID(), intent: 'CONTINUE', validUntil: at(999), expectedGraduationAt: at(999) } });
    // Fastify strips unknown fields; rider-supplied dates must never become verified facts.
    expect(forged.statusCode).toBe(200);
    expect(await prisma.riderEligibility.count({ where: { riderId: seedIds.riderB } })).toBe(0);
    expect(await prisma.riderTermQualification.count({ where: { riderId: seedIds.riderB } })).toBe(0);
    expect(await prisma.riderTermQualification.count()).toBe(1);
  });

  it('serializes calendar creation, rejects invalid dates/time zones and overlapping terms/windows', async () => {
    const input = termInput();
    const results = await Promise.all([createAcademicTerm(prisma, admin, input), createAcademicTerm(prisma, admin, input)]);
    expect(results[0]!.id).toBe(results[1]!.id);
    await expect(createAcademicTerm(prisma, admin, { ...input, name: 'changed' })).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    const overlaps = await Promise.allSettled([createAcademicTerm(prisma, admin, { ...input, requestKey: randomUUID() }), createAcademicTerm(prisma, admin, { ...input, requestKey: randomUUID() })]);
    expect(overlaps.every((result) => result.status === 'rejected')).toBe(true);
    await expect(createAcademicTerm(prisma, admin, { ...input, requestKey: randomUUID(), timeZone: 'Mars' })).rejects.toMatchObject({ code: 'INVALID_TIME_ZONE' });
    await expect(createAcademicTerm(prisma, admin, { ...input, startsAt: input.endsAt })).rejects.toMatchObject({ code: 'INVALID_ACADEMIC_TERM' });
    await expect(createAcademicTerm(prisma, admin, { ...input, requestKey: randomUUID(), startsAt: at(90), endsAt: at(180) })).rejects.toMatchObject({ code: 'ACADEMIC_TERM_OVERLAP' });
    const holiday = await createAcademicTerm(prisma, admin, { ...input, requestKey: randomUUID(), startsAt: at(90), endsAt: at(180), renewalOpensAt: at(70), renewalClosesAt: at(89), reminderStartsAt: at(60) });
    await expect(submitRenewal(prisma, rider, { termId: holiday.id, intent: 'CONTINUE', requestKey: randomUUID() }, now)).rejects.toMatchObject({ code: 'RENEWAL_WINDOW_CLOSED' });
    expect((await getMyEligibility(prisma, rider, new Date(at(70)))).renewalWindows.find((w) => w.id === holiday.id)).toMatchObject({ canApply: true, reminderDue: true });
    expect(await prisma.academicTerm.count()).toBe(2);
  });

  it('records a single intent per semester, does not approve by self declaration, and supports both reminder boundaries', async () => {
    const term = await createAcademicTerm(prisma, admin, termInput());
    const input = { termId: term.id, intent: 'CONTINUE' as const, requestKey: randomUUID() };
    const first = await Promise.all([submitRenewal(prisma, rider, input, now), submitRenewal(prisma, rider, input, now)]);
    expect(first[0]!.id).toBe(first[1]!.id);
    expect((await submitRenewal(prisma, rider, { ...input, requestKey: randomUUID() }, now)).id).toBe(first[0]!.id);
    expect(await prisma.riderRenewalRequest.count()).toBe(1);
    expect((await getMyEligibility(prisma, rider, now)).state).toBe('UNDER_REVIEW');
    expect(await prisma.riderEligibility.count()).toBe(0);
    await expect(submitRenewal(prisma, rider, { ...input, intent: 'DECLINE' }, now)).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    const riderB = { id: seedIds.riderBUser, role: 'RIDER' as const, riderId: seedIds.riderB };
    await submitRenewal(prisma, riderB, { ...input, requestKey: randomUUID(), intent: 'DECLINE' }, now);
    expect((await getMyEligibility(prisma, riderB, now)).state).toBe('NONE');
    await expect(submitRenewal(prisma, riderB, { ...input, termId: randomUUID(), requestKey: randomUUID() }, now)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('protects review retries and stale/concurrent versions; preserves audit when correcting a rejection', async () => {
    const term = await createAcademicTerm(prisma, admin, termInput());
    const input = approval(term.id);
    const reviews = await Promise.all([reviewEligibility(prisma, admin, seedIds.riderA, input, now), reviewEligibility(prisma, admin, seedIds.riderA, input, now)]);
    expect(reviews[0]).toEqual(reviews[1]);
    expect(await prisma.riderEligibilityReview.count()).toBe(1);
    await expect(reviewEligibility(prisma, admin, seedIds.riderA, { ...input, reason: 'modified retry' }, now)).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    await expect(reviewEligibility(prisma, admin, seedIds.riderA, approval(term.id), now)).rejects.toMatchObject({ code: 'ELIGIBILITY_VERSION_CONFLICT' });
    const rejections = await Promise.allSettled([1, 2].map(() => reviewEligibility(prisma, admin, seedIds.riderA, { action: 'REJECT', termId: term.id, expectedVersion: 1, requestKey: randomUUID(), reason: 'Fixture missing verification', verificationMethod: 'Fixture screenshot review, insufficient material' }, now)));
    expect(rejections.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect((await getMyEligibility(prisma, rider, now)).state).toBe('REJECTED');
    await submitRenewal(prisma, rider, { termId: term.id, intent: 'CONTINUE', requestKey: randomUUID() }, now);
    expect((await getMyEligibility(prisma, rider, now)).state).toBe('REJECTED');
    await reviewEligibility(prisma, admin, seedIds.riderA, approval(term.id, 2), now);
    const audited = await prisma.riderEligibilityReview.findMany({ orderBy: { version: 'asc' } });
    expect(audited.map((r) => r.action)).toEqual(['APPROVE', 'REJECT', 'APPROVE']);
    expect(audited[2]!.before).toMatchObject({ termReview: { decision: 'REJECTED' } });
    expect(audited.every((r) => r.actorId === seedIds.admin)).toBe(true);
  });

  it('keeps different semesters independent and requires review in each semester', async () => {
    const first = await createAcademicTerm(prisma, admin, termInput());
    const second = await createAcademicTerm(prisma, admin, { ...termInput(), startsAt: at(90), endsAt: at(180), renewalOpensAt: at(70), renewalClosesAt: at(100), reminderStartsAt: at(60) });
    await reviewEligibility(prisma, admin, seedIds.riderA, approval(first.id), now);
    expect((await getMyEligibility(prisma, rider, new Date(at(90)))).state).toBe('RENEWAL_REQUIRED');
    await enableGate();
    const task = await ready();
    await expect(claimTask(prisma, rider, task.taskId, new Date(at(90)))).rejects.toMatchObject({ code: 'RIDER_QUALIFICATION_REQUIRED', details: { state: 'RENEWAL_REQUIRED' } });
    await submitRenewal(prisma, rider, { termId: second.id, intent: 'CONTINUE', requestKey: randomUUID() }, new Date(at(80)));
    expect((await getMyEligibility(prisma, rider, new Date(at(90)))).state).toBe('UNDER_REVIEW');
    await reviewEligibility(prisma, admin, seedIds.riderA, { ...approval(second.id, 1), action: 'APPROVE', termId: second.id, validFrom: at(90), validUntil: at(180) }, now);
    expect((await getMyEligibility(prisma, rider, now)).state).toBe('VALID');
    expect((await getMyEligibility(prisma, rider, new Date(at(90)))).state).toBe('VALID');
    expect(await prisma.riderTermQualification.count()).toBe(2);
  });

  it('derives graduation from verified facts only and never approves a graduate exception', async () => {
    const term = await createAcademicTerm(prisma, admin, termInput());
    await reviewEligibility(prisma, admin, seedIds.riderA, { action: 'SET_GRADUATION', expectedVersion: 0, requestKey: randomUUID(), reason: 'Verified fixture graduation', verificationMethod: 'Fixture student portal viewed manually', expectedGraduationAt: at(1), graduationReminderAt: at(-1) }, now);
    await expect(reviewEligibility(prisma, admin, seedIds.riderA, approval(term.id, 1), now)).rejects.toMatchObject({ code: 'GRADUATE_EXCEPTION_NOT_DEFINED' });
    await reviewEligibility(prisma, admin, seedIds.riderA, { ...approval(term.id, 1), action: 'APPROVE', termId: term.id, validFrom: at(-30), validUntil: at(1) }, now);
    expect(await getMyEligibility(prisma, rider, now)).toMatchObject({ state: 'VALID', graduationReminderDue: true });
    const graduated = new Date(at(1));
    expect((await getMyEligibility(prisma, rider, graduated)).state).toBe('GRADUATED');
    await submitRenewal(prisma, rider, { termId: term.id, requestKey: randomUUID(), intent: 'GRADUATE_EXCEPTION' }, graduated);
    expect((await getMyEligibility(prisma, rider, graduated)).state).toBe('GRADUATED');
    await expect(reviewEligibility(prisma, admin, seedIds.riderA, { ...approval(term.id, 2), action: 'APPROVE', termId: term.id, validFrom: at(-30), validUntil: at(1) }, graduated)).rejects.toMatchObject({ code: 'GRADUATE_EXCEPTION_NOT_DEFINED' });
    expect(await prisma.user.findUnique({ where: { id: rider.id } })).toMatchObject({ active: true, role: 'RIDER' });
    expect(await prisma.rider.findUnique({ where: { id: rider.riderId } })).toMatchObject({ status: 'AVAILABLE' });
  });

  it('requires manual verification method and retains it without collecting original student documents', async () => {
    const term = await createAcademicTerm(prisma, admin, termInput());
    const input = approval(term.id);
    await expect(reviewEligibility(prisma, admin, seedIds.riderA, { ...input, verificationMethod: ' ' }, now)).rejects.toMatchObject({ code: 'VERIFICATION_METHOD_REQUIRED' });
    const { verificationMethod: _method, ...missing } = input;
    expect((await app.inject({ method: 'POST', url: `/admin/riders/${seedIds.riderA}/eligibility/reviews`, headers: headers(seedIds.admin), payload: missing })).statusCode).toBe(400);
    await reviewEligibility(prisma, admin, seedIds.riderA, input, now);
    expect((await prisma.riderEligibilityReview.findFirstOrThrow()).request).toMatchObject({ verificationMethod: input.verificationMethod });
    const doc = app.swagger();
    expect(doc.paths).toHaveProperty('/riders/me/eligibility');
    expect(doc.paths).toHaveProperty('/admin/academic-terms');
    expect(doc.paths).toHaveProperty('/admin/riders/{riderId}/eligibility/reviews');
  });

  it('preserves unknown legacy claims until explicit activation, then gates pool and direct claim with the same qualification', async () => {
    const held = await ready();
    expect((await claim(held.taskId)).statusCode).toBe(200);
    const term = await createAcademicTerm(prisma, admin, termInput());
    await enableGate();
    const open = await ready();
    expect((await available()).json()).toEqual([]);
    expect((await claim(open.taskId)).json()).toMatchObject({ code: 'RIDER_QUALIFICATION_REQUIRED', details: { state: 'NONE', policyVersion: 1 } });
    await submitRenewal(prisma, rider, { termId: term.id, intent: 'CONTINUE', requestKey: randomUUID() }, now);
    expect((await claim(open.taskId)).json().details.state).toBe('UNDER_REVIEW');
    await reviewEligibility(prisma, admin, rider.riderId, approval(term.id), now);
    expect((await available()).json().map((t: { id: string }) => t.id)).toContain(open.taskId);
    expect((await claim(open.taskId)).statusCode).toBe(200);
    expect(await getMyEligibility(prisma, rider)).toMatchObject({ state: 'VALID', claimGateEnforced: true, enforcementConfigVersion: 1 });
    expect(await prisma.deliveryTask.findUnique({ where: { id: held.taskId } })).toMatchObject({ status: 'CLAIMED', riderId: rider.riderId });
  });

  it('requires an authorized, valid, versioned switch; seed does not disable an explicitly enabled gate', async () => {
    const url = `/admin/business-configs/${eligibilityPolicyKey}`;
    const payload = { payload: { enforced: true }, reason: 'Explicit test activation', expectedVersion: 0 };
    for (const id of [seedIds.operator, rider.id, seedIds.merchantUser, seedIds.customer]) expect((await app.inject({ method: 'PUT', url, headers: headers(id), payload })).statusCode).toBe(403);
    expect((await app.inject({ method: 'PUT', url, headers: headers(seedIds.admin), payload: { payload: { enforced: true }, reason: 'missing version' } })).json().code).toBe('CONFIG_VERSION_REQUIRED');
    expect((await app.inject({ method: 'PUT', url, headers: headers(seedIds.admin), payload: { ...payload, payload: { enforced: 'true' } } })).json().code).toBe('INVALID_ELIGIBILITY_POLICY');
    expect((await app.inject({ method: 'PUT', url, headers: headers(seedIds.admin), payload })).json().code).toBe('ACADEMIC_CALENDAR_REQUIRED');
    await createAcademicTerm(prisma, admin, termInput());
    expect((await app.inject({ method: 'PUT', url, headers: headers(seedIds.admin), payload })).statusCode).toBe(200);
    expect((await app.inject({ method: 'PUT', url, headers: headers(seedIds.admin), payload })).json().code).toBe('CONFIG_VERSION_CONFLICT');
    expect(await prisma.businessConfigAudit.findFirst({ where: { key: eligibilityPolicyKey } })).toMatchObject({ actorId: seedIds.admin, newVersion: 1, afterPayload: { enforced: true } });
    await seedDatabase(prisma);
    expect((await getMyEligibility(prisma, rider)).claimGateEnforced).toBe(true);
    const disabled = await app.inject({ method: 'PUT', url, headers: headers(seedIds.admin), payload: { payload: { enforced: false }, reason: 'Audited test rollback', expectedVersion: 1 } });
    expect(disabled.statusCode).toBe(200);
    expect(await getMyEligibility(prisma, rider)).toMatchObject({ claimGateEnforced: false, enforcementConfigVersion: 2, state: 'NONE' });
  });

  it('enforces qualification entry/expiry and rejection even when AVAILABLE, without changing open orders', async () => {
    const term = await createAcademicTerm(prisma, admin, termInput());
    const from = new Date(Date.now() + 60000), until = new Date(from.getTime() + 60000);
    await reviewEligibility(prisma, admin, rider.riderId, { ...approval(term.id), action: 'APPROVE', termId: term.id, validFrom: from.toISOString(), validUntil: until.toISOString() });
    await enableGate();
    const task = await ready();
    await expect(claimTask(prisma, rider, task.taskId, new Date(from.getTime() - 1))).rejects.toMatchObject({ code: 'RIDER_QUALIFICATION_REQUIRED', details: { state: 'NOT_YET_VALID' } });
    await expect(claimTask(prisma, rider, task.taskId, until)).rejects.toMatchObject({ code: 'RIDER_QUALIFICATION_REQUIRED', details: { state: 'RENEWAL_REQUIRED' } });
    const entry = await ready();
    await claimTask(prisma, rider, entry.taskId, from);
    expect(await prisma.deliveryTask.findUnique({ where: { id: entry.taskId } })).toMatchObject({ status: 'CLAIMED' });
    await reviewEligibility(prisma, admin, rider.riderId, { action: 'REJECT', termId: term.id, expectedVersion: 1, requestKey: randomUUID(), reason: 'Fixture reject after review', verificationMethod: 'Insufficient fixture evidence' });
    await expect(claimTask(prisma, rider, task.taskId, from)).rejects.toMatchObject({ code: 'RIDER_QUALIFICATION_REQUIRED', details: { state: 'REJECTED' } });
    expect((await available()).json()).toEqual([]);
    expect(await prisma.deliveryTask.findUnique({ where: { id: task.taskId } })).toMatchObject({ status: 'OPEN', riderId: null });
    expect(await prisma.deliveryAssignment.count({ where: { taskId: task.taskId } })).toBe(0);
  });

  it('blocks graduation at the exact instant, but preserves prior assignments, earned income and later fulfillment', async () => {
    const term = await createAcademicTerm(prisma, admin, termInput());
    await reviewEligibility(prisma, admin, rider.riderId, approval(term.id)); await enableGate();
    const earned = await ready(); expect((await claim(earned.taskId)).statusCode).toBe(200);
    expect((await merchantPickup(app, prisma, earned.taskId)).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: `/delivery-tasks/${earned.taskId}/deliver`, headers: headers(rider.id), payload: {} })).statusCode).toBe(200);
    const income = await prisma.riderSettlement.findFirstOrThrow({ where: { orderId: earned.orderId } });
    const held = await ready(); expect((await claim(held.taskId)).statusCode).toBe(200);
    expect((await merchantPickup(app, prisma, held.taskId)).statusCode).toBe(200);
    const pricing = await prisma.orderPricing.findUniqueOrThrow({ where: { orderId: held.orderId } });
    const graduation = new Date(Date.now() + 60000);
    await reviewEligibility(prisma, admin, rider.riderId, { action: 'SET_GRADUATION', expectedVersion: 1, requestKey: randomUUID(), reason: 'Verified fixture graduation', verificationMethod: 'Fixture student portal manual check', expectedGraduationAt: graduation.toISOString(), graduationReminderAt: new Date(graduation.getTime() - 60000).toISOString() });
    const finalBefore = await ready(); await claimTask(prisma, rider, finalBefore.taskId, new Date(graduation.getTime() - 1));
    const denied = await ready();
    await expect(claimTask(prisma, rider, denied.taskId, graduation)).rejects.toMatchObject({ code: 'RIDER_QUALIFICATION_REQUIRED', details: { state: 'GRADUATED' } });
    await reviewEligibility(prisma, admin, rider.riderId, { action: 'SET_GRADUATION', expectedVersion: 2, requestKey: randomUUID(), reason: 'Corrected verified fixture graduation in past', verificationMethod: 'Fixture manual followup', expectedGraduationAt: at(-1), graduationReminderAt: at(-2) });
    expect((await available()).json()).toEqual([]);
    expect((await claim(denied.taskId)).statusCode).toBe(409);
    expect(await prisma.riderSettlement.findUnique({ where: { id: income.id } })).toEqual(income);
    expect(await prisma.orderPricing.findUnique({ where: { orderId: held.orderId } })).toEqual(pricing);
    expect((await app.inject({ method: 'POST', url: `/delivery-tasks/${held.taskId}/deliver`, headers: headers(rider.id), payload: {} })).statusCode).toBe(200);
    expect(await prisma.deliveryTask.findUnique({ where: { id: held.taskId } })).toMatchObject({ status: 'COMPLETED' });
    expect(await prisma.riderSettlement.count({ where: { riderId: rider.riderId } })).toBe(2);
    expect(await prisma.user.findUnique({ where: { id: rider.id } })).toMatchObject({ active: true });
  });

  it('serializes qualification changes with claim and preserves an earlier legitimate assignment', async () => {
    const term = await createAcademicTerm(prisma, admin, termInput());
    await reviewEligibility(prisma, admin, rider.riderId, approval(term.id)); await enableGate();
    const task = await ready();
    const results = await Promise.allSettled([claimTask(prisma, rider, task.taskId), reviewEligibility(prisma, admin, rider.riderId, { action: 'REJECT', termId: term.id, expectedVersion: 1, requestKey: randomUUID(), reason: 'Fixture concurrent rejection', verificationMethod: 'Fixture material recheck' })]);
    expect(results[1]!.status).toBe('fulfilled');
    const claimSucceeded = results[0]!.status === 'fulfilled';
    expect(await prisma.deliveryAssignment.count({ where: { taskId: task.taskId, status: 'ACTIVE' } })).toBe(claimSucceeded ? 1 : 0);
    const another = await ready();
    expect((await claim(another.taskId)).statusCode).toBe(409);
    expect((await available()).json()).toEqual([]);
  });

  it('uses live time after lock waits so a pre-expiry request cannot claim after graduation', async () => {
    const term = await createAcademicTerm(prisma, admin, termInput());
    await reviewEligibility(prisma, admin, rider.riderId, approval(term.id)); await enableGate();
    const task = await ready();
    const graduation = new Date(Date.now() + 500);
    await reviewEligibility(prisma, admin, rider.riderId, { action: 'SET_GRADUATION', expectedVersion: 1, requestKey: randomUUID(), reason: 'Verified fixture expiry during wait', verificationMethod: 'Fixture manual portal check', expectedGraduationAt: graduation.toISOString(), graduationReminderAt: at(-1) });
    let release!: () => void, acquired!: () => void;
    const waitForRelease = new Promise<void>((resolve) => { release = resolve; });
    const waitForLock = new Promise<void>((resolve) => { acquired = resolve; });
    const blocker = prisma.$transaction(async (tx) => { await tx.$queryRaw`SELECT "id" FROM "Order" WHERE "id" = ${task.orderId}::uuid FOR UPDATE`; acquired(); await waitForRelease; });
    await waitForLock;
    const result = claimTask(prisma, rider, task.taskId).catch((error: unknown) => error);
    await new Promise((resolve) => setTimeout(resolve, 750));
    const releasedAt = Date.now(); release(); await blocker;
    const error = await result;
    expect(error).toMatchObject({ code: 'RIDER_QUALIFICATION_REQUIRED', details: { state: 'GRADUATED' } });
    const evaluatedAt = (error as { details: { evaluatedAt: string } }).details.evaluatedAt;
    expect(new Date(evaluatedAt).getTime()).toBeGreaterThanOrEqual(releasedAt);
    expect(await prisma.deliveryAssignment.count({ where: { taskId: task.taskId } })).toBe(0);
  });

  it('keeps exactly one claim under concurrency with explicit verification for both riders', async () => {
    const term = await createAcademicTerm(prisma, admin, termInput());
    await reviewEligibility(prisma, admin, rider.riderId, approval(term.id));
    await reviewEligibility(prisma, admin, seedIds.riderB, approval(term.id)); await enableGate();
    const task = await ready();
    const results = await Promise.allSettled([claimTask(prisma, rider, task.taskId), claimTask(prisma, { id: seedIds.riderBUser, role: 'RIDER', riderId: seedIds.riderB }, task.taskId)]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(await prisma.deliveryAssignment.count({ where: { taskId: task.taskId, status: 'ACTIVE' } })).toBe(1);
  });

  it('serializes first-time enforcement versions and preserves only claims that precede activation', async () => {
    await createAcademicTerm(prisma, admin, termInput());
    const task = await ready();
    const results = await Promise.allSettled([enableGate(), enableGate(), claimTask(prisma, rider, task.taskId)]);
    expect(results.slice(0, 2).filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(await prisma.businessConfig.count({ where: { key: eligibilityPolicyKey } })).toBe(1);
    expect(await prisma.businessConfigAudit.count({ where: { key: eligibilityPolicyKey } })).toBe(1);
    const initialClaimSucceeded = results[2]!.status === 'fulfilled';
    expect(await prisma.deliveryAssignment.count({ where: { taskId: task.taskId } })).toBe(initialClaimSucceeded ? 1 : 0);
    const afterActivation = await ready();
    expect((await claim(afterActivation.taskId)).json()).toMatchObject({ code: 'RIDER_QUALIFICATION_REQUIRED', details: { state: 'NONE' } });
  });
});
