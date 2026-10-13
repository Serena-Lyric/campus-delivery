import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { preparationFixture, requestHeaders } from './preparation-fixture.js';
import { demoPolicy, seedIds } from '../../prisma/seed.js';

describe('pending no-fault exit releases only personal capacity', () => {
  let f: Awaited<ReturnType<typeof preparationFixture>>;
  beforeAll(async () => { f = await preparationFixture(); });
  beforeEach(async () => {
    await f.clearOrders();
    await f.prisma.businessConfig.update({ where: { id: seedIds.policyConfig }, data: { payload: demoPolicy, isActive: true } });
    await f.prisma.rider.update({ where: { id: f.riders[0]!.id }, data: { capacityOverride: 1 } });
  });
  afterAll(async () => { await f.close(); });
  async function pending() {
    const order = await f.published();
    const claim = await f.claim(order.taskId);
    expect(claim.statusCode, claim.body).toBe(200);
    const assignmentId = claim.json().activeAssignmentId as string;
    const report = await f.app.inject({ method: 'POST', url: `/orders/${order.orderId}/exceptions`, headers: requestHeaders(f.riders[0]!.userId),
      payload: { type: 'MERCHANT_PREPARATION_UNAVAILABLE', description: 'Cannot prepare; request audited exit', assignmentId, expectedVersion: 0, requestKey: randomUUID() } });
    expect(report.statusCode, report.body).toBe(201);
    const exit = await f.app.inject({ method: 'POST', url: `/delivery-tasks/${order.taskId}/request-preparation-exit`, headers: requestHeaders(f.riders[0]!.userId),
      payload: { assignmentId, expectedVersion: 1, requestKey: randomUUID(), reason: 'Request reviewed no-fault exit' } });
    expect(exit.statusCode, exit.body).toBe(200);
    return { ...order, assignmentId, version: exit.json().version as number };
  }
  async function ownCase(orderId: string) {
    const entry = await f.prisma.exceptionCase.findFirstOrThrow({ where: { orderId } });
    const claimed = await f.app.inject({ method: 'POST', url: `/admin/exception-cases/${entry.id}/claim`, headers: requestHeaders(seedIds.operator), payload: { expectedVersion: entry.version } });
    expect(claimed.statusCode, claimed.body).toBe(200);
    return { id: entry.id, version: claimed.json().version as number };
  }
  const review = (order: { orderId: string; assignmentId: string; version: number }, caseVersion: number, approve: boolean, user: string = seedIds.operator, extra = {}) =>
    f.app.inject({ method: 'POST', url: `/admin/orders/${order.orderId}/preparation-exit-review`, headers: requestHeaders(user), payload: {
      assignmentId: order.assignmentId, expectedVersion: order.version, expectedCaseVersion: caseVersion, approve, requestKey: randomUUID(), reason: 'Authorized factual exit review', ...extra,
    } });

  it('retains unresolved assignments in the 10-order hard limit even while all personal slots are temporarily freed', async () => {
    for (let i = 0; i < 10; i++) await pending();
    const extra = await f.published();
    const denied = await f.claim(extra.taskId);
    expect(denied.statusCode).toBe(409);
    expect(denied.json().code).toBe('RIDER_GLOBAL_ORDER_LIMIT');
    expect(await f.prisma.deliveryAssignment.count({ where: { riderId: f.riders[0]!.id, status: 'ACTIVE' } })).toBe(10);
    const capacity = await f.app.inject({ method: 'GET', url: '/riders/me/capacity', headers: requestHeaders(f.riders[0]!.userId) });
    expect(capacity.json()).toMatchObject({ globalHeldCount: 10, personalHeldCount: 0, remainingCapacity: 0 });
  });

  it('restores personal occupation on rejection without cancelling the additional legitimate assignment', async () => {
    const first = await pending();
    const second = await f.published();
    expect((await f.claim(second.taskId)).statusCode).toBe(200);
    const handled = await ownCase(first.orderId);
    expect((await review(first, handled.version, false)).statusCode).toBe(200);
    const assignments = await f.prisma.deliveryAssignment.findMany({ where: { riderId: f.riders[0]!.id, status: 'ACTIVE' } });
    expect(assignments).toHaveLength(2);
    expect(assignments.find((a) => a.id === first.assignmentId)).toMatchObject({ temporaryPersonalCapacityRelease: false, noFaultExitStatus: 'REJECTED' });
    const third = await f.published();
    expect((await f.claim(third.taskId)).statusCode).toBe(409);
    expect((await f.app.inject({ method: 'GET', url: '/riders/me/capacity', headers: requestHeaders(f.riders[0]!.userId) })).json()).toMatchObject({ globalHeldCount: 2, personalHeldCount: 2, remainingCapacity: 0 });
  });

  it('requires the actual current handler, guarded versions and idempotency before formal assignment release', async () => {
    const first = await pending();
    const handled = await ownCase(first.orderId);
    expect((await review(first, handled.version, true, seedIds.admin)).statusCode).toBe(403);
    expect((await review(first, handled.version - 1, true)).statusCode).toBe(409);
    const key = randomUUID();
    const a = await review(first, handled.version, true, seedIds.operator, { requestKey: key });
    expect(a.statusCode, a.body).toBe(200);
    const b = await review(first, handled.version, true, seedIds.operator, { requestKey: key });
    expect(b.statusCode, b.body).toBe(200);
    expect((await f.prisma.deliveryAssignment.findUniqueOrThrow({ where: { id: first.assignmentId } })).status).toBe('ABANDONED');
    const task = await f.prisma.deliveryTask.findUniqueOrThrow({ where: { id: first.taskId } });
    expect(task).toMatchObject({ riderId: null, status: 'OPEN' });
    // Formal release does not silently make an unavailable order claimable again.
    expect((await f.claim(first.taskId, f.riders[1]!.userId)).statusCode).toBe(409);
    expect(await f.prisma.riderCancellationEvent.count({ where: { riderId: f.riders[0]!.id } })).toBe(0);
    expect(await f.prisma.riderSettlement.count({ where: { orderId: first.orderId } })).toBe(0);
  });

  it('does not release an assignment through one case while another current conflict is unresolved', async () => {
    const first = await pending();
    const handled = await ownCase(first.orderId);
    const other = await f.app.inject({ method: 'POST', url: `/orders/${first.orderId}/exceptions`, headers: requestHeaders(seedIds.customer),
      payload: { type: 'OTHER_NEEDS_REVIEW', description: 'Another unresolved factual conflict' } });
    expect(other.statusCode).toBe(201);
    expect((await review(first, handled.version, true)).statusCode).toBe(409);
    expect((await f.prisma.deliveryAssignment.findUniqueOrThrow({ where: { id: first.assignmentId } })).status).toBe('ACTIVE');
  });
});
