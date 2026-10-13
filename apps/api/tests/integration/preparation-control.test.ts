import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { preparationFixture, requestHeaders } from './preparation-fixture.js';
import { seedIds } from '../../prisma/seed.js';
import { expireUnclaimedDeliveryTasks } from '../../src/orders/lifecycle.js';
import { applyPreparationAction } from '../../src/orders/preparation-control.js';
import { claimTask } from '../../src/delivery/service.js';
import type { PrismaClient } from '@prisma/client';
import { escalateExceptionCase } from '../../src/exception-cases/service.js';

describe('preparation pause and recovery are independent of market and settlement facts', () => {
  let f: Awaited<ReturnType<typeof preparationFixture>>;
  let orderId: string;
  let taskId: string;
  beforeAll(async () => { f = await preparationFixture(); });
  beforeEach(async () => { await f.clearOrders(); ({ orderId, taskId } = await f.published()); });
  afterAll(async () => { await f.close(); });
  const action = (name: string, expectedVersion: number, extra = {}, user?: string) => f.app.inject({
    method: 'POST', url: `/merchant/orders/${orderId}/preparation/${name}`, headers: requestHeaders(user ?? f.ownerId),
    payload: { expectedVersion, requestKey: randomUUID(), ...extra },
  });
  const control = () => f.app.inject({ method: 'GET', url: `/orders/${orderId}/preparation-control`, headers: requestHeaders(seedIds.customer) });
  const report = (assignmentId: string, expectedVersion = 0, user?: string) => f.app.inject({ method: 'POST', url: `/orders/${orderId}/exceptions`,
    headers: requestHeaders(user ?? f.riders[0]!.userId), payload: { type: 'MERCHANT_PREPARATION_UNAVAILABLE', description: 'Merchant cannot prepare this order', assignmentId, expectedVersion, requestKey: randomUUID() } });
  const respond = (assignmentId: string, expectedVersion: number, accept: boolean, user?: string) => f.app.inject({ method: 'POST', url: `/delivery-tasks/${taskId}/preparation-recovery-response`,
    headers: requestHeaders(user ?? f.riders[0]!.userId), payload: { assignmentId, expectedVersion, requestKey: randomUUID(), accept } });

  it('pauses both the pool and direct claims, with one idempotent declaration and no changed financial/task facts', async () => {
    const task = await f.prisma.deliveryTask.findUniqueOrThrow({ where: { id: taskId } });
    const money = await f.prisma.orderPricing.findUniqueOrThrow({ where: { orderId } });
    const key = randomUUID();
    const declare = () => action('unable', 0, { reason: 'Ingredients unavailable', requestKey: key });
    const replies = await Promise.all([declare(), declare()]);
    expect(replies.map((r) => r.statusCode)).toEqual([200, 200]);
    expect((await control()).json()).toMatchObject({ state: 'UNABLE', version: 1, claimPaused: true });
    const pool = await f.app.inject({ method: 'GET', url: '/delivery-tasks/available', headers: requestHeaders(f.riders[0]!.userId) });
    expect(pool.json().some((t: { id: string }) => t.id === taskId)).toBe(false);
    expect((await f.claim(taskId)).statusCode).toBe(409);
    expect(await f.prisma.deliveryTask.findUniqueOrThrow({ where: { id: taskId } })).toEqual(task);
    expect(await f.prisma.orderPricing.findUniqueOrThrow({ where: { orderId } })).toEqual(money);
    expect((await f.prisma.order.findUniqueOrThrow({ where: { id: orderId } })).status).toBe('READY_FOR_RIDER');
    expect((await action('unable', 0, { reason: 'Other reason', requestKey: key })).statusCode).toBe(409);
  });

  it('restores an unclaimed order only within its original deadline and never creates a new 40-minute window', async () => {
    const task = await f.prisma.deliveryTask.findUniqueOrThrow({ where: { id: taskId } });
    expect((await action('unable', 0, { reason: 'Temporary failure' })).statusCode).toBe(200);
    expect((await action('recover', 1)).statusCode).toBe(200);
    expect((await control()).json()).toMatchObject({ state: 'NORMAL', version: 2, claimPaused: false });
    expect((await f.claim(taskId)).statusCode).toBe(200);
    const after = await f.prisma.deliveryTask.findUniqueOrThrow({ where: { id: taskId } });
    expect(after.firstPublishedAt).toEqual(task.firstPublishedAt);
    expect(after.claimDeadline).toEqual(task.claimDeadline);
  });

  it('distinguishes paused deadline expiry from natural no-rider failure and creates exactly one manual case', async () => {
    await action('unable', 0, { reason: 'Cannot make the whole order' });
    const money = await f.prisma.orderPricing.findUniqueOrThrow({ where: { orderId } });
    await f.prisma.deliveryTask.update({ where: { id: taskId }, data: { firstPublishedAt: new Date(Date.now() - 2_401_000), claimDeadline: new Date(Date.now() - 1000), finalUserWarningAt: new Date(Date.now() - 301_000) } });
    await Promise.all([expireUnclaimedDeliveryTasks(f.prisma), expireUnclaimedDeliveryTasks(f.prisma)]);
    expect((await control()).json()).toMatchObject({ state: 'MANUAL_REVIEW', claimPaused: true });
    expect(await f.prisma.exceptionCase.count({ where: { orderId } })).toBe(1);
    await expireUnclaimedDeliveryTasks(f.prisma);
    expect(await f.prisma.exceptionCase.count({ where: { orderId } })).toBe(1);
    expect((await f.prisma.order.findUniqueOrThrow({ where: { id: orderId } })).status).toBe('READY_FOR_RIDER');
    expect(await f.prisma.orderPricing.findUniqueOrThrow({ where: { orderId } })).toEqual(money);
    expect((await action('recover', (await control()).json().version)).json()).toMatchObject({ state: 'MANUAL_REVIEW' });
    expect((await f.claim(taskId)).statusCode).toBe(409);
  });

  it('requires the same active rider to accept recovery after a formal report, preserving the assignment', async () => {
    const claimed = await f.claim(taskId);
    expect(claimed.statusCode).toBe(200);
    const assignmentId = claimed.json().activeAssignmentId;
    const assignment = await f.prisma.deliveryAssignment.findUniqueOrThrow({ where: { id: assignmentId } });
    expect((await report(assignmentId)).statusCode).toBe(201);
    expect((await action('recover', 1)).json()).toMatchObject({ state: 'RECOVERY_PENDING', requiresRiderResponse: true });
    expect((await f.app.inject({ method: 'POST', url: `/merchant/orders/${orderId}/confirm-rider-pickup`, headers: requestHeaders(f.ownerId), payload: { assignmentId, expectedRevision: 0, requestKey: randomUUID() } })).statusCode).toBe(409);
    expect((await respond(assignmentId, 2, true, f.riders[1]!.userId)).statusCode).toBe(403);
    expect((await respond(assignmentId, 1, true)).statusCode).toBe(409);
    expect((await respond(assignmentId, 2, true)).json()).toMatchObject({ state: 'NORMAL', requiresRiderResponse: false });
    expect(await f.prisma.deliveryAssignment.findUniqueOrThrow({ where: { id: assignmentId } })).toEqual(assignment);
  });

  it('keeps a rejected or unanswered recovery in manual review without default acceptance, release, money or a chosen timeout', async () => {
    const claimed = await f.claim(taskId);
    const assignmentId = claimed.json().activeAssignmentId;
    await report(assignmentId);
    await action('recover', 1);
    const pending = (await control()).json();
    expect(pending).toMatchObject({ state: 'RECOVERY_PENDING', automaticEscalationEnabled: false, recoveryTimeoutSeconds: null });
    const money = await f.prisma.orderPricing.findUniqueOrThrow({ where: { orderId } });
    expect((await respond(assignmentId, 2, false)).json()).toMatchObject({ state: 'MANUAL_REVIEW' });
    expect((await f.prisma.deliveryAssignment.findUniqueOrThrow({ where: { id: assignmentId } })).status).toBe('ACTIVE');
    expect((await f.prisma.deliveryTask.findUniqueOrThrow({ where: { id: taskId } })).riderId).toBe(f.riders[0]!.id);
    expect(await f.prisma.orderPricing.findUniqueOrThrow({ where: { orderId } })).toEqual(money);
  });

  it('rejects cross-store writers, extra fields, stale versions and legacy termination on the new controlled flow', async () => {
    expect((await action('unable', 0, { reason: 'x' }, seedIds.merchantUser)).statusCode).toBe(403);
    expect((await action('unable', 0, { reason: 'x', customerRefundMinor: 100 })).statusCode).toBe(400);
    expect((await action('unable', 0, { reason: 'x' })).statusCode).toBe(200);
    expect((await action('recover', 0)).statusCode).toBe(409);
    const closed = await f.app.inject({ method: 'POST', url: `/admin/orders/${orderId}/exception`, headers: requestHeaders(seedIds.admin), payload: { reason: 'Must use legal handler workflow' } });
    expect(closed.statusCode).toBe(409);
    const own = await f.app.inject({ method: 'GET', url: `/orders/${orderId}`, headers: requestHeaders(seedIds.customer) });
    expect(own.json().preparationControl).toMatchObject({ state: 'UNABLE', claimPaused: true });
    for (const field of ['preparationSourceExceptionId', 'preparationReportedAssignmentId', 'operatorId', 'requestKey']) expect(JSON.stringify(own.json())).not.toContain(`"${field}":`);
  });

  it('offers manual escalation for unanswered recovery and cannot let the merchant clear manual review', async () => {
    const claimed = await f.claim(taskId);
    await report(claimed.json().activeAssignmentId);
    await action('recover', 1);
    const escalated = await f.app.inject({ method: 'POST', url: `/orders/${orderId}/preparation-escalate`, headers: requestHeaders(seedIds.customer), payload: { expectedVersion: 2, requestKey: randomUUID(), reason: 'No rider response; human review requested' } });
    expect(escalated.statusCode).toBe(200);
    expect(escalated.json()).toMatchObject({ state: 'MANUAL_REVIEW', version: 3 });
    await action('unable', 3, { reason: 'Merchant repeats inability' });
    expect((await action('recover', 4)).json()).toMatchObject({ state: 'MANUAL_REVIEW' });
    expect(await f.prisma.exceptionCase.count({ where: { orderId } })).toBe(1);
  });

  it('does not let ordinary recovery bypass an escalated shared case', async () => {
    const claimed = await f.claim(taskId);
    await report(claimed.json().activeAssignmentId);
    const entry = await f.prisma.exceptionCase.findFirstOrThrow({ where: { orderId } });
    const picked = await f.app.inject({ method: 'POST', url: `/admin/exception-cases/${entry.id}/claim`, headers: requestHeaders(seedIds.operator), payload: { expectedVersion: entry.version } });
    expect(picked.statusCode).toBe(200);
    const escalated = await f.app.inject({ method: 'POST', url: `/admin/exception-cases/${entry.id}/escalate`, headers: requestHeaders(seedIds.operator), payload: { expectedVersion: picked.json().version, reason: 'Superior factual review required' } });
    expect(escalated.statusCode, escalated.body).toBe(200);
    expect((await action('recover', 1)).statusCode).toBe(409);
    expect((await control()).json().state).toBe('UNABLE');
  });

  it('does not accept recovery when another unresolved case appears after the proposal', async () => {
    const claimed = await f.claim(taskId);
    const assignmentId = claimed.json().activeAssignmentId;
    await report(assignmentId);
    await action('recover', 1);
    const other = await f.app.inject({ method: 'POST', url: `/orders/${orderId}/exceptions`, headers: requestHeaders(seedIds.customer), payload: { type: 'OTHER_NEEDS_REVIEW', description: 'A separate unresolved conflict' } });
    expect(other.statusCode, other.body).toBe(201);
    expect((await respond(assignmentId, 2, true)).statusCode).toBe(409);
    expect((await control()).json().state).toBe('RECOVERY_PENDING');
    expect((await f.prisma.deliveryAssignment.findUniqueOrThrow({ where: { id: assignmentId } })).status).toBe('ACTIVE');
  });

  it('does not let preparation review bypass a separate delivery-exception case', async () => {
    const claimed = await f.claim(taskId);
    await report(claimed.json().activeAssignmentId);
    const other = await f.app.inject({ method: 'POST', url: `/orders/${orderId}/exceptions`, headers: requestHeaders(f.riders[0]!.userId), payload: { type: 'RIDER_DELIVERY_EXCEPTION', description: 'A separate delivery obstacle' } });
    expect(other.statusCode, other.body).toBe(201);
    await action('recover', 2);
    const entry = await f.prisma.exceptionCase.findFirstOrThrow({ where: { orderId, category: 'MERCHANT_PREPARATION_UNAVAILABLE' } });
    const handling = await f.app.inject({ method: 'POST', url: `/admin/exception-cases/${entry.id}/claim`, headers: requestHeaders(seedIds.operator), payload: { expectedVersion: entry.version } });
    const reviewed = await f.app.inject({ method: 'POST', url: `/admin/orders/${orderId}/preparation-review`, headers: requestHeaders(seedIds.operator), payload: {
      expectedVersion: 3, expectedCaseVersion: handling.json().version, requestKey: randomUUID(), outcome: 'REQUEST_RIDER_CONFIRMATION', reason: 'Preparation alone recovered',
    } });
    expect(reviewed.statusCode, reviewed.body).toBe(409);
    expect((await control()).json().state).toBe('MANUAL_REVIEW');
  });

  async function lockWait() {
    for (let i = 0; i < 300; i++) {
      const rows = await f.prisma.$queryRaw<Array<{ waiting: boolean }>>`SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%"Order"%') AS waiting`;
      if (rows[0]?.waiting) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error('No real order lock wait observed');
  }
  it('rejects a queued claim if the inability declaration commits first under the actual order lock', async () => {
    let announce!: () => void;
    let unlock!: () => void;
    const held = new Promise<void>((resolve) => { announce = resolve; });
    const release = new Promise<void>((resolve) => { unlock = resolve; });
    const gated = f.prisma.$extends({ query: { order: { async updateMany({ args, query }) { const result = await query(args); announce(); await release; return result; } } } });
    const pausing = applyPreparationAction(gated as unknown as PrismaClient, { id: f.ownerId, role: 'MERCHANT', merchantId: f.merchantId }, orderId, 'DECLARE_UNABLE', { expectedVersion: 0, requestKey: randomUUID(), reason: 'Pause first' });
    await held;
    const claiming = f.claim(taskId);
    try { await lockWait(); } finally { unlock(); }
    await pausing;
    expect((await claiming).statusCode).toBe(409);
    expect(await f.prisma.deliveryAssignment.count({ where: { orderId } })).toBe(0);
  });
  it('preserves an earlier legitimate assignment when a declaration waits behind its claim', async () => {
    let announce!: () => void;
    let unlock!: () => void;
    const held = new Promise<void>((resolve) => { announce = resolve; });
    const release = new Promise<void>((resolve) => { unlock = resolve; });
    const gated = f.prisma.$extends({ query: { deliveryAssignment: { async create({ args, query }) { const result = await query(args); announce(); await release; return result; } } } });
    const claiming = claimTask(gated as unknown as PrismaClient, { id: f.riders[0]!.userId, role: 'RIDER', riderId: f.riders[0]!.id }, taskId);
    await held;
    const pausing = action('unable', 0, { reason: 'Pause after earlier claim' });
    try { await lockWait(); } finally { unlock(); }
    await claiming;
    expect((await pausing).statusCode).toBe(200);
    expect((await f.prisma.order.findUniqueOrThrow({ where: { id: orderId } })).status).toBe('CLAIMED');
    expect(await f.prisma.deliveryAssignment.count({ where: { orderId, status: 'ACTIVE' } })).toBe(1);
    expect((await control()).json().state).toBe('UNABLE');
  });

  it('allows the actual handler to clear an unclaimed manual pause only after a merchant recovery proposal', async () => {
    await action('unable', 0, { reason: 'Unavailable' });
    await f.app.inject({ method: 'POST', url: `/orders/${orderId}/preparation-escalate`, headers: requestHeaders(seedIds.customer), payload: { expectedVersion: 1, requestKey: randomUUID(), reason: 'Human review requested' } });
    const entry = await f.prisma.exceptionCase.findFirstOrThrow({ where: { orderId } });
    const claimed = await f.app.inject({ method: 'POST', url: `/admin/exception-cases/${entry.id}/claim`, headers: requestHeaders(seedIds.operator), payload: { expectedVersion: entry.version } });
    const review = (expectedVersion: number, user: string = seedIds.operator, requestKey = randomUUID()) => f.app.inject({ method: 'POST', url: `/admin/orders/${orderId}/preparation-review`, headers: requestHeaders(user), payload: {
      expectedVersion, expectedCaseVersion: claimed.json().version, requestKey, outcome: 'ALLOW_UNCLAIMED_RECOVERY', reason: 'Verified merchant recovery and no remaining conflict',
    } });
    expect((await review(2)).statusCode).toBe(409);
    await action('recover', 2);
    expect((await review(3, seedIds.admin)).statusCode).toBe(403);
    const requestKey = randomUUID();
    expect((await review(3, seedIds.operator, requestKey)).json()).toMatchObject({ state: 'NORMAL', version: 4 });
    expect((await review(3, seedIds.operator, requestKey)).json()).toMatchObject({ state: 'NORMAL', version: 4 });
    expect((await f.prisma.exceptionCase.findUniqueOrThrow({ where: { id: entry.id } })).status).toBe('RESOLVED');
    expect((await f.claim(taskId)).statusCode).toBe(200);
    expect((await review(3, seedIds.operator, requestKey)).statusCode).toBe(409);
    expect(await f.prisma.riderSettlement.count({ where: { orderId } })).toBe(0);
  });

  it('waits for a concurrent case escalation and refuses recovery after the escalation commits first', async () => {
    const claimed = await f.claim(taskId);
    const assignmentId = claimed.json().activeAssignmentId;
    await report(assignmentId);
    await action('recover', 1);
    const entry = await f.prisma.exceptionCase.findFirstOrThrow({ where: { orderId } });
    const handling = await f.app.inject({ method: 'POST', url: `/admin/exception-cases/${entry.id}/claim`, headers: requestHeaders(seedIds.operator), payload: { expectedVersion: entry.version } });
    let announce!: () => void;
    let unlock!: () => void;
    const held = new Promise<void>((resolve) => { announce = resolve; });
    const release = new Promise<void>((resolve) => { unlock = resolve; });
    const gated = f.prisma.$extends({ query: { exceptionCase: { async updateMany({ args, query }) { const result = await query(args); announce(); await release; return result; } } } });
    const escalating = escalateExceptionCase(gated as unknown as PrismaClient, { id: seedIds.operator, role: 'ADMIN', adminLevel: 'OPERATOR' }, entry.id, handling.json().version, 'Concurrent superior review');
    await held;
    const replying = respond(assignmentId, 2, true);
    try {
      let observed = false;
      for (let i = 0; i < 300; i++) {
        const rows = await f.prisma.$queryRaw<Array<{ waiting: boolean }>>`SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%"ExceptionCase"%') AS waiting`;
        if (rows[0]?.waiting) { observed = true; break; }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(observed).toBe(true);
    } finally { unlock(); }
    await escalating;
    expect((await replying).statusCode).toBe(409);
    expect((await control()).json().state).toBe('RECOVERY_PENDING');
  });

  it('blocks delivery after a recovered order develops a post-pickup delivery exception without terminating it automatically', async () => {
    await action('unable', 0, { reason: 'Temporary failure' });
    await action('recover', 1);
    const claimed = await f.claim(taskId);
    const pickup = await f.app.inject({ method: 'POST', url: `/merchant/orders/${orderId}/confirm-rider-pickup`, headers: requestHeaders(f.ownerId), payload: { assignmentId: claimed.json().activeAssignmentId, expectedRevision: 0, requestKey: randomUUID() } });
    expect(pickup.statusCode, pickup.body).toBe(200);
    const evidence = await f.app.inject({ method: 'POST', url: `/orders/${orderId}/evidence`, headers: requestHeaders(f.riders[0]!.userId), payload: { evidenceType: 'DELIVERY_PHOTO', media: { fileName: 'delivery.jpg', contentType: 'image/jpeg' } } });
    expect(evidence.statusCode).toBe(201);
    const report = await f.app.inject({ method: 'POST', url: `/orders/${orderId}/exceptions`, headers: requestHeaders(f.riders[0]!.userId), payload: { type: 'RIDER_DELIVERY_EXCEPTION', description: 'Cannot safely continue delivery' } });
    expect(report.statusCode).toBe(201);
    const delivered = await f.app.inject({ method: 'POST', url: `/delivery-tasks/${taskId}/deliver`, headers: requestHeaders(f.riders[0]!.userId), payload: { evidenceId: evidence.json().id } });
    expect(delivered.statusCode).toBe(409);
    expect((await f.prisma.order.findUniqueOrThrow({ where: { id: orderId } })).status).toBe('PICKED_UP');
    expect(await f.prisma.riderSettlement.count({ where: { orderId } })).toBe(0);
    const entry = await f.prisma.exceptionCase.findFirstOrThrow({ where: { orderId, category: 'RIDER_DELIVERY_EXCEPTION' } });
    const handling = await f.app.inject({ method: 'POST', url: `/admin/exception-cases/${entry.id}/claim`, headers: requestHeaders(seedIds.operator), payload: { expectedVersion: entry.version } });
    const resume = (user: string) => f.app.inject({ method: 'POST', url: `/admin/exception-cases/${entry.id}/resolve`, headers: requestHeaders(user),
      payload: { expectedVersion: handling.json().version, resolutionType: 'CONTINUE_FULFILLMENT', note: 'Verified the delivery obstacle has been resolved' } });
    expect((await resume(seedIds.admin)).statusCode).toBe(403);
    const continued = await resume(seedIds.operator);
    expect(continued.statusCode, continued.body).toBe(200);
    expect(await f.prisma.riderSettlement.count({ where: { orderId } })).toBe(0);
    expect((await f.app.inject({ method: 'POST', url: `/delivery-tasks/${taskId}/deliver`, headers: requestHeaders(f.riders[0]!.userId), payload: { evidenceId: evidence.json().id } })).statusCode).toBe(200);
    expect(await f.prisma.riderSettlement.count({ where: { orderId } })).toBe(1);
  });

  it('does not let an older generic case clear a subsequent formal merchant-preparation objection', async () => {
    await action('unable', 0, { reason: 'Temporary failure' });
    await action('recover', 1);
    const claimed = await f.claim(taskId);
    const generic = await f.app.inject({ method: 'POST', url: `/orders/${orderId}/exceptions`, headers: requestHeaders(f.riders[0]!.userId), payload: { type: 'RIDER_DELIVERY_EXCEPTION', description: 'Ordinary pre-pickup obstacle' } });
    expect(generic.statusCode).toBe(201);
    expect((await report(claimed.json().activeAssignmentId, 3)).statusCode).toBe(201);
    const older = await f.prisma.exceptionCase.findUniqueOrThrow({ where: { exceptionEventId: generic.json().id } });
    const handler = await f.app.inject({ method: 'POST', url: `/admin/exception-cases/${older.id}/claim`, headers: requestHeaders(seedIds.operator), payload: { expectedVersion: older.version } });
    expect(handler.statusCode).toBe(200);
    const resolved = await f.app.inject({ method: 'POST', url: `/admin/exception-cases/${older.id}/resolve`, headers: requestHeaders(seedIds.operator), payload: { expectedVersion: handler.json().version, resolutionType: 'CONTINUE_FULFILLMENT', note: 'Only the earlier obstacle was resolved' } });
    expect(resolved.statusCode, resolved.body).toBe(200);
    expect((await control()).json().state).toBe('MANUAL_REVIEW');
    expect(await f.prisma.exceptionCase.count({ where: { orderId, category: 'MERCHANT_PREPARATION_UNAVAILABLE', status: { notIn: ['RESOLVED', 'CLOSED'] } } })).toBe(1);
  });
});
