import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { demoPolicy, seedDatabase, seedIds } from '../../prisma/seed.js';
import { releaseExpiredCoolingOrders } from '../../src/orders/lifecycle.js';
import { claimTask } from '../../src/delivery/service.js';
import { confirmRiderPickup } from '../../src/delivery/merchant-pickup.js';
import { assertTransition } from '../../src/orders/state-machine.js';
import { setMerchantBlocked } from '../../src/riders/blocklist.js';

const prisma = new PrismaClient();
const config = { databaseUrl: process.env.DATABASE_URL!, host: '127.0.0.1', port: 3000, enableDevAuth: true, enableBackgroundJobs: false, backgroundSweepIntervalMs: 5000, campusTimeZone: 'Asia/Shanghai', logLevel: 'silent' };
const headers = (id: string) => ({ 'x-user-id': id });
const rider = { id: seedIds.riderAUser, role: 'RIDER' as const, riderId: seedIds.riderA };

describe('personal blocklist and merchant pickup protocol', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  beforeAll(async () => { await seedDatabase(prisma); app = await buildApp(config, prisma); await app.ready(); });
  afterAll(async () => { await app.close(); await prisma.$disconnect(); });
  beforeEach(async () => {
    await prisma.compensationAllocation.deleteMany();
    await prisma.compensationObligation.deleteMany();
    await prisma.remakeProposal.deleteMany();
    await prisma.exceptionCaseAction.deleteMany();
    await prisma.exceptionCase.deleteMany();
    await prisma.riderRestrictionAudit.deleteMany();
    await prisma.riderRestriction.deleteMany();
    await prisma.riderCancellationEvent.deleteMany();
    await prisma.merchantExposureDecision.deleteMany();
    await prisma.subsidyRecord.deleteMany();
    await prisma.deliveryTask.deleteMany();
    await prisma.order.deleteMany();
    await prisma.riderBlockedMerchant.deleteMany();
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
  const block = (method: 'PUT' | 'DELETE', user: string = seedIds.riderAUser) => app.inject({ method, url: `/rider/blocked-merchants/${seedIds.merchant}`, headers: headers(user) });
  const available = (user: string = seedIds.riderAUser, query = '') => app.inject({ method: 'GET', url: `/delivery-tasks/available${query}`, headers: headers(user) });
  it('persists idempotently, isolates riders and roles, and keeps claimed assignments intact', async () => {
    const held = await ready();
    await claimTask(prisma, rider, held.taskId);
    const open = await ready();
    expect((await block('PUT')).statusCode).toBe(200);
    expect((await block('PUT')).statusCode).toBe(200);
    expect(await prisma.riderBlockedMerchant.count()).toBe(1);
    expect((await available()).json()).toEqual([]);
    expect((await available(seedIds.riderBUser)).json().map((t: { id: string }) => t.id)).toContain(open.taskId);
    await expect(claimTask(prisma, rider, open.taskId)).rejects.toMatchObject({ code: 'MERCHANT_BLOCKED' });
    for (const user of [seedIds.customer, seedIds.merchantUser, seedIds.operator]) expect((await block('PUT', user)).statusCode).toBe(403);
    const listed = await app.inject({ method: 'GET', url: '/rider/blocked-merchants', headers: headers(seedIds.riderBUser) });
    expect(listed.json()).toEqual([]);
    const oldName = (await prisma.merchant.findUniqueOrThrow({ where: { id: seedIds.merchant } })).name;
    await prisma.merchant.update({ where: { id: seedIds.merchant }, data: { name: 'renamed' } });
    expect((await available()).json()).toEqual([]);
    await prisma.merchant.update({ where: { id: seedIds.merchant }, data: { name: oldName } });
    expect(await prisma.deliveryTask.findUnique({ where: { id: held.taskId } })).toMatchObject({ status: 'CLAIMED', riderId: seedIds.riderA });
    expect((await block('DELETE')).statusCode).toBe(200);
    expect((await block('DELETE')).statusCode).toBe(200);
    expect((await available()).json().map((t: { id: string }) => t.id)).toContain(open.taskId);
    expect(await prisma.riderCancellationEvent.count()).toBe(0);
    expect(await prisma.riderSettlement.count()).toBe(0);
  });
  it('filters before pagination and does not match another merchant with the same name', async () => {
    await ready();
    await block('PUT');
    const user = await prisma.user.create({ data: { role: 'MERCHANT', displayName: randomUUID() } });
    const other = await prisma.merchant.create({ data: { ownerId: user.id, name: (await prisma.merchant.findUniqueOrThrow({ where: { id: seedIds.merchant } })).name, campusLocationId: seedIds.merchantLocation } });
    const one = await ready();
    const two = await ready();
    await prisma.order.updateMany({ where: { id: { in: [one.orderId, two.orderId] } }, data: { merchantId: other.id } });
    expect((await available(seedIds.riderAUser, '?limit=1&offset=0')).json().map((t: { id: string }) => t.id)).toEqual([one.taskId]);
    expect((await available(seedIds.riderAUser, '?limit=1&offset=1')).json().map((t: { id: string }) => t.id)).toEqual([two.taskId]);
    await prisma.deliveryTask.deleteMany({ where: { orderId: { in: [one.orderId, two.orderId] } } });
    await prisma.order.deleteMany({ where: { merchantId: other.id } });
    await prisma.merchant.delete({ where: { id: other.id } });
    await prisma.user.delete({ where: { id: user.id } });
  });
  it('serializes blocking with claim; an earlier successful claim stays held', async () => {
    const task = await ready();
    const results = await Promise.allSettled([claimTask(prisma, rider, task.taskId), setMerchantBlocked(prisma, rider, seedIds.merchant, true)]);
    expect(results[1]!.status).toBe('fulfilled');
    expect(await prisma.riderBlockedMerchant.count()).toBe(1);
    const current = await prisma.deliveryTask.findUniqueOrThrow({ where: { id: task.taskId } });
    expect(current.status).toBe(results[0]!.status === 'fulfilled' ? 'CLAIMED' : 'OPEN');
    expect((await available()).json()).toEqual([]);
    const next = await ready();
    await expect(claimTask(prisma, rider, next.taskId)).rejects.toMatchObject({ code: 'MERCHANT_BLOCKED' });
  });
  const merchantActor = { id: seedIds.merchantUser, role: 'MERCHANT' as const, merchantId: seedIds.merchant };
  async function claimed(mode: 'CONFIRMATION' | 'PHOTO' | 'PICKUP_CODE' = 'CONFIRMATION', core = false) {
    await prisma.merchant.update({ where: { id: seedIds.merchant }, data: { pickupVerificationMode: mode } });
    if (core) await prisma.product.update({ where: { id: seedIds.productRice }, data: { deliveryCategoryCode: 'CAKE', priceMinor: 6000 } });
    const task = await ready();
    const result = await claimTask(prisma, rider, task.taskId);
    return { ...task, assignmentId: result.activeAssignmentId!, expectedRevision: 0, requestKey: randomUUID() };
  }
  const confirm = (task: { orderId: string; assignmentId: string; expectedRevision: number; requestKey: string }, extra = {}, user: string = seedIds.merchantUser) => app.inject({ method: 'POST', url: `/merchant/orders/${task.orderId}/confirm-rider-pickup`, headers: headers(user), payload: { assignmentId: task.assignmentId, expectedRevision: task.expectedRevision, requestKey: task.requestKey, ...extra } });
  const issue = (task: { taskId: string; assignmentId: string }, user: string = seedIds.riderAUser) => app.inject({ method: 'POST', url: `/delivery-tasks/${task.taskId}/pickup-code`, headers: headers(user), payload: { assignmentId: task.assignmentId } });
  async function upload(task: { orderId: string }) {
    const photo = await app.inject({ method: 'POST', url: `/orders/${task.orderId}/evidence`, headers: headers(seedIds.riderAUser), payload: { evidenceType: 'RIDER_PICKUP_PHOTO', media: { fileName: 'pickup.jpg', contentType: 'image/jpeg', source: 'CAMERA' } } });
    expect(photo.statusCode, photo.body).toBe(201);
    return photo.json().id as string;
  }
  const deny = (task: { taskId: string; assignmentId: string }, handoffId: string, extra = {}, user: string = seedIds.riderAUser) => app.inject({ method: 'POST', url: `/delivery-tasks/${task.taskId}/dispute-pickup`, headers: headers(user), payload: { assignmentId: task.assignmentId, handoffId, reason: 'I have not received the goods', ...extra } });
  async function disputed(extra = {}) {
    const task = await claimed();
    const confirmed = await confirm(task);
    expect(confirmed.statusCode, confirmed.body).toBe(200);
    const response = await deny(task, confirmed.json().handoffId, extra);
    expect(response.statusCode, response.body).toBe(200);
    return { task, handoff: confirmed.json(), dispute: response.json() };
  }
  async function review(dispute: { id: string; caseId: string; version: number }, outcome: 'NOT_HANDED_OVER' | 'HANDED_OVER' | 'INCONCLUSIVE') {
    const current = await prisma.exceptionCase.findUniqueOrThrow({ where: { id: dispute.caseId } });
    if (current.status === 'OPEN') {
      const claim = await app.inject({ method: 'POST', url: `/admin/exception-cases/${current.id}/claim`, headers: headers(seedIds.operator), payload: { expectedVersion: current.version } });
      expect(claim.statusCode, claim.body).toBe(200);
    }
    const caseNow = await prisma.exceptionCase.findUniqueOrThrow({ where: { id: dispute.caseId } });
    const payload = { expectedVersion: dispute.version, expectedCaseVersion: caseNow.version, requestKey: randomUUID(), outcome, note: 'Reviewed statements and order evidence' };
    const response = await app.inject({ method: 'POST', url: `/admin/pickup-disputes/${dispute.id}/resolve`, headers: headers(seedIds.operator), payload });
    return { response, payload };
  }
  it('advances ordinary pickup by merchant once, retires rider and old verification entry points, and exposes dispute action', async () => {
    const task = await claimed();
    const old = await app.inject({ method: 'POST', url: `/delivery-tasks/${task.taskId}/pick-up`, headers: headers(seedIds.riderAUser), payload: {} });
    expect(old.statusCode).toBe(409);
    expect(old.json().code).toBe('MERCHANT_PICKUP_CONFIRMATION_REQUIRED');
    expect((await app.inject({ method: 'POST', url: `/orders/${task.orderId}/pickup-code`, headers: headers(seedIds.merchantUser) })).statusCode).toBe(409);
    expect((await app.inject({ method: 'POST', url: `/delivery-tasks/${task.taskId}/verify-pickup-code`, headers: headers(seedIds.riderAUser), payload: { code: '123456' } })).statusCode).toBe(409);
    const [one, two] = await Promise.all([confirm(task), confirm(task)]);
    expect(one.statusCode, one.body).toBe(200);
    expect(two.json()).toEqual(one.json());
    expect(await prisma.orderEvent.count({ where: { orderId: task.orderId, eventType: 'PICKED_UP' } })).toBe(1);
    const event = await prisma.orderEvent.findFirstOrThrow({ where: { orderId: task.orderId, eventType: 'PICKED_UP' } });
    expect(event.operatorId).toBe(seedIds.merchantUser);
    expect(event.metadata).toMatchObject({ assignmentId: task.assignmentId, physicalHandoffProven: false });
    expect(await prisma.riderSettlement.count()).toBe(0);
    const mine = await app.inject({ method: 'GET', url: '/delivery-tasks/mine', headers: headers(seedIds.riderAUser) });
    expect(mine.json()[0].pickupProtocol).toMatchObject({ confirmationBy: 'MERCHANT', canDisputePickup: true, handoff: { id: one.json().handoffId } });
    const detail = await app.inject({ method: 'GET', url: `/orders/${task.orderId}`, headers: headers(seedIds.merchantUser) });
    expect(detail.json().deliveryTask.activeAssignmentId).toBe(task.assignmentId);
    expect(JSON.stringify(detail.json())).not.toMatch(/codeHash|salt|requestKey|platformSubsidyMinor/);
    const customerDetail = await app.inject({ method: 'GET', url: `/orders/${task.orderId}`, headers: headers(seedIds.customer) });
    expect(customerDetail.json().pickupProtocol).toEqual({ confirmationBy: 'MERCHANT' });
    expect(customerDetail.json().deliveryTask).not.toHaveProperty('activeAssignmentId');
  });
  it('rejects cross merchant, wrong roles, missing assignment, stale revision, changed retry and terminal states', async () => {
    const task = await claimed();
    for (const user of [seedIds.customer, seedIds.riderAUser, seedIds.operator]) expect((await confirm(task, {}, user)).statusCode).toBe(403);
    const user = await prisma.user.create({ data: { role: 'MERCHANT', displayName: 'other owner' } });
    const merchant = await prisma.merchant.create({ data: { ownerId: user.id, name: 'other', campusLocationId: seedIds.merchantLocation } });
    expect((await confirm(task, {}, user.id)).statusCode).toBe(403);
    await prisma.merchant.delete({ where: { id: merchant.id } }); await prisma.user.delete({ where: { id: user.id } });
    expect((await confirm(task, { assignmentId: randomUUID() })).statusCode).toBe(409);
    expect((await confirm(task, { expectedRevision: 1 })).statusCode).toBe(409);
    expect((await confirm(task)).statusCode).toBe(200);
    expect((await confirm(task, { photoEvidenceId: randomUUID() })).statusCode).toBe(409);
    expect((await confirm(task, { requestKey: randomUUID() })).statusCode).toBe(409);
    expect((await app.inject({ method: 'POST', url: `/delivery-tasks/${task.taskId}/deliver`, headers: headers(seedIds.riderAUser), payload: {} })).statusCode).toBe(200);
    expect((await confirm(task)).statusCode).toBe(409);
    expect((await deny(task, (await prisma.pickupHandoff.findFirstOrThrow()).id)).statusCode).toBe(409);
  });
  it('rejects unclaimed and paused tasks but accepts a valid claim after the original deadline', async () => {
    const open = await ready();
    expect((await confirm({ ...open, assignmentId: randomUUID(), expectedRevision: 0, requestKey: randomUUID() })).statusCode).toBe(409);
    const task = await claimed();
    const stored = await prisma.deliveryTask.findUniqueOrThrow({ where: { id: task.taskId } });
    const result = await confirmRiderPickup(prisma, merchantActor, task.orderId, task, new Date(stored.claimDeadline!.getTime() + 60_000));
    expect(result.status).toBe('PICKED_UP');
    expect((await prisma.deliveryTask.findUniqueOrThrow({ where: { id: task.taskId } })).claimDeadline).toEqual(stored.claimDeadline);
    const paused = await claimed();
    await prisma.deliveryTask.update({ where: { id: paused.taskId }, data: { status: 'RISK_REVIEW' } });
    expect((await confirm(paused)).statusCode).toBe(409);
  });
  it.each(['PHOTO', 'PICKUP_CODE'] as const)('keeps %s and core REQUIRED photo as merchant preconditions', async (mode) => {
    const task = await claimed(mode, true);
    expect((await confirm(task)).statusCode).toBe(409);
    const photoEvidenceId = await upload(task);
    if (mode === 'PICKUP_CODE') {
      expect((await confirm(task, { photoEvidenceId })).statusCode).toBe(409);
      const issued = await issue(task);
      expect(issued.statusCode).toBe(201);
      const code = { codeId: issued.json().id, code: issued.json().code };
      expect((await confirm(task, code)).statusCode).toBe(409);
      expect((await confirm(task, { ...code, photoEvidenceId })).statusCode).toBe(200);
      const record = await prisma.verificationCode.findUniqueOrThrow({ where: { id: code.codeId } });
      expect(record.issuerId).toBe(seedIds.riderAUser); expect(record.verifierId).toBe(seedIds.merchantUser);
    } else expect((await confirm(task, { photoEvidenceId })).statusCode).toBe(200);
  });
  it('restricts code issuance and keeps legacy, expired, reissued and cross-assignment codes unusable', async () => {
    const task = await claimed('PICKUP_CODE');
    for (const user of [seedIds.merchantUser, seedIds.customer, seedIds.operator, seedIds.riderBUser]) expect((await issue(task, user)).statusCode).toBe(403);
    const first = await issue(task); expect(first.statusCode).toBe(201); expect(first.json().code).toMatch(/^\d{6}$/);
    const second = await issue(task); expect(second.statusCode).toBe(201);
    expect((await confirm(task, { codeId: first.json().id, code: first.json().code })).statusCode).toBe(409);
    await prisma.verificationCode.update({ where: { id: second.json().id }, data: { expiresAt: new Date(0) } });
    expect((await confirm(task, { codeId: second.json().id, code: second.json().code })).statusCode).toBe(409);
    const third = await issue(task);
    await prisma.verificationCode.update({ where: { id: third.json().id }, data: { protocolVersion: 0 } });
    expect((await confirm(task, { codeId: third.json().id, code: third.json().code })).statusCode).toBe(409);
    const other = await claimed('PICKUP_CODE'); const otherCode = await issue(other);
    expect((await confirm(task, { codeId: otherCode.json().id, code: otherCode.json().code })).statusCode).toBe(409);
  });
  it('persists failed attempts across rollbacks and reissues, including concurrent guesses', async () => {
    const task = await claimed('PICKUP_CODE');
    const first = await issue(task); const wrong = first.json().code === '000000' ? '999999' : '000000';
    const attempts = await Promise.all([1, 2, 3].map(() => confirm(task, { codeId: first.json().id, code: wrong })));
    expect(attempts.map((r) => r.statusCode)).toEqual([409, 409, 409]);
    expect((await prisma.verificationCode.findUniqueOrThrow({ where: { id: first.json().id } })).failedAttempts).toBe(3);
    const second = await issue(task); expect(second.statusCode).toBe(201);
    const wrong2 = second.json().code === '000000' ? '999999' : '000000';
    await confirm(task, { codeId: second.json().id, code: wrong2 }); await confirm(task, { codeId: second.json().id, code: wrong2 });
    const locked = await confirm(task, { codeId: second.json().id, code: second.json().code });
    expect(locked.json().code).toBe('PICKUP_CODE_RATE_LIMIT');
    expect((await issue(task)).statusCode).toBe(409);
    expect(await prisma.pickupHandoff.count()).toBe(0);
    expect((await prisma.deliveryTask.findUniqueOrThrow({ where: { id: task.taskId } })).status).toBe('CLAIMED');
  });
  it('creates one auditable dispute, isolates its rider and blocks delivery, refund and generic resolution', async () => {
    const task = await claimed(); const confirmed = await confirm(task); const id = confirmed.json().handoffId;
    expect((await deny(task, id, {}, seedIds.riderBUser)).statusCode).toBe(403);
    expect((await deny(task, id, { assignmentId: randomUUID() })).statusCode).toBe(403);
    const responses = await Promise.all([deny(task, id), deny(task, id)]);
    expect(responses[0]!.statusCode, responses[0]!.body).toBe(200); expect(responses[1]!.json()).toEqual(responses[0]!.json());
    const dispute = responses[0]!.json();
    expect((await deny(task, id, { reason: 'different' })).statusCode).toBe(409);
    expect(await prisma.pickupCustodyDispute.count()).toBe(1); expect(await prisma.exceptionCase.count()).toBe(1);
    expect((await confirm(task)).statusCode).toBe(409);
    const deliver = await app.inject({ method: 'POST', url: `/delivery-tasks/${task.taskId}/deliver`, headers: headers(seedIds.riderAUser), payload: {} });
    expect(deliver.json().code).toBe('PICKUP_CUSTODY_DISPUTED');
    const reviewed = await review(dispute, 'INCONCLUSIVE'); expect(reviewed.response.statusCode, reviewed.response.body).toBe(200);
    for (const resolutionType of ['REFUND_AND_CLOSE', 'CONTINUE_FULFILLMENT']) {
      const c = await prisma.exceptionCase.findUniqueOrThrow({ where: { id: dispute.caseId } });
      expect((await app.inject({ method: 'POST', url: `/admin/exception-cases/${c.id}/resolve`, headers: headers(seedIds.operator), payload: { expectedVersion: c.version, resolutionType, note: 'attempt bypass' } })).statusCode).toBe(409);
    }
    expect((await app.inject({ method: 'POST', url: `/delivery-tasks/${task.taskId}/deliver`, headers: headers(seedIds.riderAUser), payload: {} })).statusCode).toBe(409);
    expect(await prisma.riderSettlement.count()).toBe(0); expect(await prisma.compensationObligation.count()).toBe(0); expect(await prisma.riderCancellationEvent.count()).toBe(0);
    expect((await prisma.deliveryTask.findUniqueOrThrow({ where: { id: task.taskId } })).status).toBe('PICKED_UP');
    expect((await available()).json()).toEqual([]);
  });
  it('audits merchant agreement then permits only versioned assigned-admin correction and fresh re-confirmation', async () => {
    const { task, handoff, dispute } = await disputed();
    const before = await prisma.deliveryTask.findUniqueOrThrow({ where: { id: task.taskId } });
    const ack = await app.inject({ method: 'POST', url: `/merchant/orders/${task.orderId}/acknowledge-pickup-mistake`, headers: headers(seedIds.merchantUser), payload: { disputeId: dispute.id, expectedVersion: dispute.version, note: 'Goods remain in my store; I clicked early' } });
    expect(ack.statusCode).toBe(200);
    expect((await prisma.order.findUniqueOrThrow({ where: { id: task.orderId } })).status).toBe('PICKED_UP');
    const { response, payload } = await review(ack.json(), 'NOT_HANDED_OVER'); expect(response.statusCode, response.body).toBe(200);
    const retry = await app.inject({ method: 'POST', url: `/admin/pickup-disputes/${dispute.id}/resolve`, headers: headers(seedIds.operator), payload }); expect(retry.json()).toEqual(response.json());
    expect(() => assertTransition('PICKED_UP', 'CLAIMED')).toThrow();
    expect((await confirm(task)).statusCode).toBe(409);
    expect((await confirm({ ...task, expectedRevision: 1, requestKey: randomUUID() })).statusCode).toBe(200);
    expect(await prisma.orderEvent.count({ where: { orderId: task.orderId, eventType: 'PICKED_UP' } })).toBe(2);
    expect(await prisma.orderEvent.findUnique({ where: { id: handoff.eventId } })).not.toBeNull();
    const after = await prisma.deliveryTask.findUniqueOrThrow({ where: { id: task.taskId } });
    expect(after.firstPublishedAt).toEqual(before.firstPublishedAt); expect(after.claimDeadline).toEqual(before.claimDeadline);
    expect(await prisma.deliveryAssignment.count({ where: { taskId: task.taskId, status: 'ACTIVE' } })).toBe(1);
  });
  it('requires new code and current-revision photo after a corrected false handoff', async () => {
    const task = await claimed('PICKUP_CODE', true); const photoEvidenceId = await upload(task); const code = await issue(task);
    const confirmed = await confirm(task, { photoEvidenceId, codeId: code.json().id, code: code.json().code }); expect(confirmed.statusCode).toBe(200);
    const dispute = await deny(task, confirmed.json().handoffId); const resolved = await review(dispute.json(), 'NOT_HANDED_OVER'); expect(resolved.response.statusCode).toBe(200);
    const next = { ...task, expectedRevision: 1, requestKey: randomUUID() };
    expect((await confirm(next, { photoEvidenceId, codeId: code.json().id, code: code.json().code })).statusCode).toBe(409);
    const fresh = await upload(task); const newCode = await issue(task); expect(newCode.statusCode).toBe(201);
    expect((await confirm(next, { photoEvidenceId: fresh, codeId: code.json().id, code: code.json().code })).statusCode).toBe(409);
    expect((await confirm(next, { photoEvidenceId: fresh, codeId: newCode.json().id, code: newCode.json().code })).statusCode).toBe(200);
    expect((await deny(task, confirmed.json().handoffId)).json().status).toBe('NOT_HANDED_OVER');
  });
  it('keeps custody when handoff is verified and resumes delivery without a compensation debt', async () => {
    const { task, dispute } = await disputed(); const reviewResult = await review(dispute, 'HANDED_OVER'); expect(reviewResult.response.statusCode, reviewResult.response.body).toBe(200);
    expect((await app.inject({ method: 'POST', url: `/delivery-tasks/${task.taskId}/deliver`, headers: headers(seedIds.riderAUser), payload: {} })).statusCode).toBe(200);
    expect(await prisma.riderSettlement.count()).toBe(1); expect(await prisma.compensationObligation.count()).toBe(0);
    expect((await app.inject({ method: 'POST', url: `/admin/pickup-disputes/${dispute.id}/resolve`, headers: headers(seedIds.operator), payload: { ...reviewResult.payload, requestKey: randomUUID(), outcome: 'NOT_HANDED_OVER' } })).statusCode).toBe(409);
  });
  it('retains a catalog misdeclaration claim after merchant pickup and enables audited refusal after no-handoff review', async () => {
    const task = await claimed(); const item = await prisma.orderItem.findFirstOrThrow({ where: { orderId: task.orderId } }); const handoff = await confirm(task);
    const risk = { orderItemId: item.id, observedCategoryCode: 'CAKE' };
    const dispute = await deny(task, handoff.json().handoffId, { catalogRiskClaim: risk }); expect(dispute.statusCode).toBe(200);
    const report = () => app.inject({ method: 'POST', url: `/delivery-tasks/${task.taskId}/report-catalog-risk`, headers: headers(seedIds.riderAUser), payload: { assignmentId: task.assignmentId, ...risk, reason: 'I have not received the goods' } });
    expect((await report()).statusCode).toBe(409);
    expect((await review(dispute.json(), 'NOT_HANDED_OVER')).response.statusCode).toBe(200);
    expect(await prisma.catalogRiskReport.count({ where: { assignmentId: task.assignmentId } })).toBe(1);
    expect((await confirm({ ...task, expectedRevision: 1, requestKey: randomUUID() })).statusCode).toBe(409);
    expect((await report()).statusCode).toBe(200);
    expect((await prisma.deliveryTask.findUniqueOrThrow({ where: { id: task.taskId } })).status).toBe('RISK_REVIEW');
    expect(await prisma.riderCancellationEvent.count()).toBe(0); expect(await prisma.riderRestriction.count()).toBe(0);
    expect(await prisma.orderEvent.count({ where: { orderId: task.orderId, eventType: 'PICKED_UP' } })).toBe(1);
  });
  it('serializes denial with delivery so either disputed custody blocks income or completed delivery rejects denial', async () => {
    const task = await claimed(); const handoff = await confirm(task);
    const [dispute, delivered] = await Promise.all([deny(task, handoff.json().handoffId), app.inject({ method: 'POST', url: `/delivery-tasks/${task.taskId}/deliver`, headers: headers(seedIds.riderAUser), payload: {} })]);
    expect([dispute.statusCode, delivered.statusCode].sort()).toEqual([200, 409]);
    expect(await prisma.riderSettlement.count()).toBe(delivered.statusCode === 200 ? 1 : 0);
    expect(await prisma.pickupCustodyDispute.count()).toBe(dispute.statusCode === 200 ? 1 : 0);
  });
  it('publishes the new protocol in OpenAPI while marking the old pickup route deprecated', async () => {
    const spec = app.swagger();
    expect(spec.paths).toHaveProperty('/merchant/orders/{orderId}/confirm-rider-pickup');
    expect(spec.paths).toHaveProperty('/delivery-tasks/{taskId}/dispute-pickup');
    expect(spec.paths?.['/delivery-tasks/{taskId}/pick-up']?.post?.deprecated).toBe(true);
  });

  it('bounds code reissuance and never lets a merchant read codes via order, timeline or rider routes', async () => {
    const task = await claimed('PICKUP_CODE');
    for (let i = 0; i < 5; i++) expect((await issue(task)).statusCode).toBe(201);
    expect((await issue(task)).json().code).toBe('PICKUP_CODE_RATE_LIMIT');
    for (const url of [`/orders/${task.orderId}`, `/orders/${task.orderId}/timeline`]) {
      const response = await app.inject({ method: 'GET', url, headers: headers(seedIds.merchantUser) });
      expect(response.statusCode).toBe(200); expect(response.body).not.toMatch(/codeHash|salt|\"code\"\s*:\s*\"[0-9]{6}\"|failedAttempts/);
    }
    expect((await issue(task, seedIds.merchantUser)).statusCode).toBe(403);
  });
  it('rejects unassigned or stale review and requires super-admin takeover after escalation', async () => {
    const { task, dispute } = await disputed();
    const c = await prisma.exceptionCase.findUniqueOrThrow({ where: { id: dispute.caseId } });
    const payload = { expectedVersion: 0, expectedCaseVersion: c.version, requestKey: randomUUID(), outcome: 'NOT_HANDED_OVER', note: 'review' };
    const resolve = (user: string, body = payload) => app.inject({ method: 'POST', url: `/admin/pickup-disputes/${dispute.id}/resolve`, headers: headers(user), payload: body });
    expect((await resolve(seedIds.operator)).statusCode).toBe(403);
    expect((await resolve(seedIds.admin)).statusCode).toBe(403);
    const claimedCase = await app.inject({ method: 'POST', url: `/admin/exception-cases/${c.id}/claim`, headers: headers(seedIds.operator), payload: { expectedVersion: c.version } }); expect(claimedCase.statusCode).toBe(200);
    expect((await resolve(seedIds.operator)).statusCode).toBe(409);
    const escalated = await app.inject({ method: 'POST', url: `/admin/exception-cases/${c.id}/escalate`, headers: headers(seedIds.operator), payload: { expectedVersion: claimedCase.json().version, reason: 'conflicting accounts' } }); expect(escalated.statusCode).toBe(200);
    expect((await resolve(seedIds.operator, { ...payload, expectedCaseVersion: escalated.json().version })).statusCode).toBe(409);
    const takeover = await app.inject({ method: 'POST', url: `/admin/exception-cases/${c.id}/takeover`, headers: headers(seedIds.admin), payload: { expectedVersion: escalated.json().version, nextHandlerAdminId: seedIds.admin, reason: 'take over review' } }); expect(takeover.statusCode).toBe(200);
    expect((await resolve(seedIds.admin, { ...payload, expectedCaseVersion: takeover.json().version, expectedVersion: 1 })).statusCode).toBe(409);
    expect((await resolve(seedIds.admin, { ...payload, expectedCaseVersion: takeover.json().version })).statusCode).toBe(200);
    expect((await prisma.order.findUniqueOrThrow({ where: { id: task.orderId } })).status).toBe('CLAIMED');
  });
  it('rejects stale merchant agreement, other-actor evidence and fraudulent catalog facts', async () => {
    const task = await claimed(); const handoff = await confirm(task);
    expect((await deny(task, handoff.json().handoffId, { evidenceIds: [randomUUID()] })).statusCode).toBe(400);
    expect((await deny(task, handoff.json().handoffId, { catalogRiskClaim: { orderItemId: randomUUID(), observedCategoryCode: 'CAKE' } })).statusCode).toBe(400);
    const dispute = await deny(task, handoff.json().handoffId); expect(dispute.statusCode).toBe(200);
    const response = await app.inject({ method: 'POST', url: `/merchant/orders/${task.orderId}/acknowledge-pickup-mistake`, headers: headers(seedIds.merchantUser), payload: { disputeId: dispute.json().id, expectedVersion: 1, note: 'stale acknowledgement' } }); expect(response.statusCode).toBe(409);
    expect((await prisma.pickupCustodyDispute.findUniqueOrThrow({ where: { id: dispute.json().id } })).merchantAcknowledgedAt).toBeNull();
  });
  it('blocks refund through another case on the disputed order and preserves existing earned balances', async () => {
    const earned = await claimed(); await confirm(earned);
    expect((await app.inject({ method: 'POST', url: `/delivery-tasks/${earned.taskId}/deliver`, headers: headers(seedIds.riderAUser), payload: {} })).statusCode).toBe(200);
    const balance = await prisma.riderSettlement.update({ where: { orderId: earned.orderId }, data: { reservedMinor: 20 } });
    const task = await claimed(); await confirm(task);
    const pricing = await prisma.orderPricing.findUniqueOrThrow({ where: { orderId: task.orderId } });
    const event = await app.inject({ method: 'POST', url: `/orders/${task.orderId}/exceptions`, headers: headers(seedIds.customer), payload: { type: 'DELIVERY_DISPUTE', description: 'Please investigate' } }); expect(event.statusCode).toBe(201);
    const otherCase = await prisma.exceptionCase.findUniqueOrThrow({ where: { exceptionEventId: event.json().id } });
    const claimedCase = await app.inject({ method: 'POST', url: `/admin/exception-cases/${otherCase.id}/claim`, headers: headers(seedIds.operator), payload: { expectedVersion: otherCase.version } }); expect(claimedCase.statusCode).toBe(200);
    const handoff = await prisma.pickupHandoff.findFirstOrThrow({ where: { orderId: task.orderId } });
    const dispute = await deny(task, handoff.id); expect(dispute.statusCode).toBe(200);
    const refund = await app.inject({ method: 'POST', url: `/admin/exception-cases/${otherCase.id}/resolve`, headers: headers(seedIds.operator), payload: { expectedVersion: claimedCase.json().version, resolutionType: 'REFUND_AND_CLOSE', note: 'try another case' } });
    expect(refund.json().code).toBe('PICKUP_CUSTODY_DISPUTED');
    expect((await review(dispute.json(), 'NOT_HANDED_OVER')).response.statusCode).toBe(200);
    expect(await prisma.orderPricing.findUniqueOrThrow({ where: { orderId: task.orderId } })).toEqual(pricing);
    expect(await prisma.riderSettlement.findUniqueOrThrow({ where: { id: balance.id } })).toEqual(balance);
    expect(await prisma.compensationObligation.count()).toBe(0);
  });
  it('serializes conflicting review requests and preserves the first factual conclusion', async () => {
    const { dispute } = await disputed(); const claimedCase = await app.inject({ method: 'POST', url: `/admin/exception-cases/${dispute.caseId}/claim`, headers: headers(seedIds.operator), payload: { expectedVersion: 0 } }); expect(claimedCase.statusCode).toBe(200);
    const resolve = (outcome: string) => app.inject({ method: 'POST', url: `/admin/pickup-disputes/${dispute.id}/resolve`, headers: headers(seedIds.operator), payload: { expectedVersion: 0, expectedCaseVersion: claimedCase.json().version, requestKey: randomUUID(), outcome, note: 'reviewed' } });
    const results = await Promise.all([resolve('NOT_HANDED_OVER'), resolve('HANDED_OVER')]);
    expect(results.map((r) => r.statusCode).sort()).toEqual([200, 409]);
    expect(await prisma.exceptionCaseAction.count({ where: { caseId: dispute.caseId, type: 'RESOLVED' } })).toBe(1);
  });

  it('accepts a telephone-friendly six-digit code without requiring the rider to relay a UUID', async () => {
    const task = await claimed('PICKUP_CODE'); const issued = await issue(task);
    const response = await confirm(task, { code: issued.json().code }); expect(response.statusCode, response.body).toBe(200);
    expect((await confirm(task, { code: issued.json().code })).json()).toEqual(response.json());
    expect((await prisma.pickupHandoff.findUniqueOrThrow({ where: { id: response.json().handoffId } })).verificationCodeId).toBe(issued.json().id);
  });

});
