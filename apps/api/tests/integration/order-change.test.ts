import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { preparationFixture, requestHeaders } from './preparation-fixture.js';
import { seedIds } from '../../prisma/seed.js';
import { expireUnclaimedDeliveryTasks } from '../../src/orders/lifecycle.js';
import { appendChangeNotice } from '../../src/orders/order-change.js';
import type { PrismaClient } from '@prisma/client';

describe('append-only change notices and independent goods-risk review', () => {
  let f: Awaited<ReturnType<typeof preparationFixture>>;
  let orderId: string;
  let taskId: string;
  beforeAll(async () => { f = await preparationFixture(); });
  beforeEach(async () => { await f.clearOrders(); ({ orderId, taskId } = await f.published()); });
  afterAll(async () => { await f.close(); });
  const notice = (expectedVersion: number, riskDeclaration = 'NO_ADDITIONAL_CORE_FRAGILE', extra = {}, user?: string) => f.app.inject({ method: 'POST', url: `/merchant/orders/${orderId}/change-notices`, headers: requestHeaders(user ?? f.ownerId), payload: { expectedVersion, requestKey: randomUUID(), content: 'Merchant and customer discussed a substitution', riskDeclaration, ...extra } });
  const details = (user: string = seedIds.customer) => f.app.inject({ method: 'GET', url: `/orders/${orderId}/change-notices`, headers: requestHeaders(user) });
  const pickup = (assignmentId: string, extra = {}) => f.app.inject({ method: 'POST', url: `/merchant/orders/${orderId}/confirm-rider-pickup`, headers: requestHeaders(f.ownerId), payload: { assignmentId, expectedRevision: 0, requestKey: randomUUID(), ...extra } });
  const ack = (noticeId: string, assignmentId: string, user?: string) => f.app.inject({ method: 'POST', url: `/delivery-tasks/${taskId}/change-notices/${noticeId}/acknowledge`, headers: requestHeaders(user ?? f.riders[0]!.userId), payload: { assignmentId } });

  it('appends notices with merchant identity snapshots, exposes necessary pool facts, and never changes goods/money/risk/deadline', async () => {
    const before = await f.prisma.order.findUniqueOrThrow({ where: { id: orderId }, include: { items: true, pricing: true, deliveryTask: true } });
    const first = await notice(0);
    expect(first.statusCode, first.body).toBe(201);
    expect((await notice(1, 'NO_ADDITIONAL_CORE_FRAGILE', { content: 'Another change' })).statusCode).toBe(201);
    await f.prisma.merchant.update({ where: { id: f.merchantId }, data: { name: 'Later renamed shop' } });
    const history = (await details()).json();
    expect(history.notices).toHaveLength(2);
    expect(history.notices[0]).toMatchObject({ version: 1, merchantName: before.pickupMerchantNameSnapshot, riskDeclaration: 'NO_ADDITIONAL_CORE_FRAGILE', selfReported: true });
    const pool = await f.app.inject({ method: 'GET', url: '/delivery-tasks/available', headers: requestHeaders(f.riders[0]!.userId) });
    expect(pool.json().find((t: { id: string }) => t.id === taskId).changeNotices).toHaveLength(2);
    const after = await f.prisma.order.findUniqueOrThrow({ where: { id: orderId }, include: { items: true, pricing: true, deliveryTask: true } });
    expect(after.items).toEqual(before.items); expect(after.pricing).toEqual(before.pricing); expect(after.deliveryTask).toEqual(before.deliveryTask);
    expect(after.pickupEvidenceLevel).toBe(before.pickupEvidenceLevel); expect(after.coreFragileValueMinor).toBe(before.coreFragileValueMinor);
    for (const key of ['actorId', 'requestKey', 'payloadSignature', 'goodsChangeSourceExceptionId', 'merchantDeliveryContributionMinor', 'platformSubsidyMinor']) expect(JSON.stringify(history)).not.toContain(`"${key}":`);
  });

  it('allows pickup without acknowledgement and never uses acknowledgement as a waiver', async () => {
    const sent = await notice(0);
    expect(sent.statusCode).toBe(201);
    const claimed = await f.claim(taskId);
    expect((await pickup(claimed.json().activeAssignmentId)).statusCode).toBe(200);
    expect((await notice(1)).statusCode).toBe(409);
  });

  it('records one voluntary acknowledgement per notice and current assignment, without inheriting new notices', async () => {
    const first = await notice(0);
    expect(first.statusCode).toBe(201);
    const claimed = await f.claim(taskId); const assignmentId = claimed.json().activeAssignmentId;
    const replies = await Promise.all([ack(first.json().id, assignmentId), ack(first.json().id, assignmentId)]);
    expect(replies.map((r) => r.statusCode)).toEqual([200, 200]);
    expect(replies[0]!.json().acknowledgedAt).toBe(replies[1]!.json().acknowledgedAt);
    expect(replies[0]!.json()).toMatchObject({ acceptsSubstitution: false, waivesProtection: false });
    expect((await ack(first.json().id, assignmentId, f.riders[1]!.userId)).statusCode).toBe(403);
    await notice(1);
    const view = (await details(f.riders[0]!.userId)).json();
    expect(view.notices[0].acknowledgedAt).toBeTruthy(); expect(view.notices[1].acknowledgedAt).toBeNull();
  });

  it.each(['ADDITIONAL_CORE_FRAGILE', 'UNASSESSED'])('keeps %s risk paused despite a later no-risk declaration and prevents direct claim/expiry accounting', async (risk) => {
    expect((await notice(0, risk)).statusCode).toBe(201);
    expect((await notice(1)).statusCode).toBe(201);
    expect((await details()).json()).toMatchObject({ reviewPending: true, version: 2 });
    const pool = await f.app.inject({ method: 'GET', url: '/delivery-tasks/available', headers: requestHeaders(f.riders[0]!.userId) });
    expect(pool.json().find((t: { id: string }) => t.id === taskId)).toMatchObject({ claimable: false, goodsChangeReview: { reviewPending: true } });
    expect((await f.claim(taskId)).statusCode).toBe(409);
    const money = await f.prisma.orderPricing.findUniqueOrThrow({ where: { orderId } });
    await f.prisma.deliveryTask.update({ where: { id: taskId }, data: { firstPublishedAt: new Date(Date.now() - 2_401_000), claimDeadline: new Date(Date.now() - 1000), finalUserWarningAt: new Date(Date.now() - 301_000) } });
    await expireUnclaimedDeliveryTasks(f.prisma);
    expect((await f.prisma.order.findUniqueOrThrow({ where: { id: orderId } })).status).toBe('READY_FOR_RIDER');
    expect(await f.prisma.orderPricing.findUniqueOrThrow({ where: { orderId } })).toEqual(money);
  });

  it('blocks current-rider pickup for unknown risk, including after voluntary acknowledgement', async () => {
    const claimed = await f.claim(taskId); const assignmentId = claimed.json().activeAssignmentId;
    const sent = await notice(0, 'UNASSESSED'); expect(sent.statusCode).toBe(201);
    expect((await ack(sent.json().id, assignmentId)).statusCode).toBe(200);
    expect((await pickup(assignmentId)).statusCode).toBe(409);
    expect((await f.prisma.deliveryAssignment.findUniqueOrThrow({ where: { id: assignmentId } })).status).toBe('ACTIVE');
    expect(await f.prisma.riderSettlement.count({ where: { orderId } })).toBe(0);
  });

  it('binds a goods objection through the existing report entry, retaining acknowledgement and evidence', async () => {
    const sent = await notice(0); expect(sent.statusCode).toBe(201);
    const claimed = await f.claim(taskId); const assignmentId = claimed.json().activeAssignmentId;
    await ack(sent.json().id, assignmentId);
    const report = () => f.app.inject({ method: 'POST', url: `/orders/${orderId}/exceptions`, headers: requestHeaders(f.riders[0]!.userId), payload: { type: 'GOODS_CHANGE_OBJECTION', assignmentId, noticeId: sent.json().id, expectedVersion: 1, requestKey: key, description: 'Actual contents differ from declaration' } });
    const key = randomUUID(); const replies = await Promise.all([report(), report()]);
    expect(replies.map((r) => r.statusCode)).toEqual([201, 201]);
    expect(await f.prisma.exceptionCase.count({ where: { orderId } })).toBe(1);
    expect((await details(f.riders[0]!.userId)).json().notices[0].acknowledgedAt).toBeTruthy();
    expect((await pickup(assignmentId)).statusCode).toBe(409);
  });

  it('requires the current handler and fresh case/notice facts; unknown value remains held without invented money', async () => {
    await notice(0, 'UNASSESSED');
    const entry = await f.prisma.exceptionCase.findFirstOrThrow({ where: { orderId } });
    const handling = await f.app.inject({ method: 'POST', url: `/admin/exception-cases/${entry.id}/claim`, headers: requestHeaders(seedIds.operator), payload: { expectedVersion: entry.version } });
    const review = (expectedVersion: number, expectedCaseVersion: number, outcome: string, extra = {}, user: string = seedIds.operator) => f.app.inject({ method: 'POST', url: `/admin/orders/${orderId}/goods-change-review`, headers: requestHeaders(user), payload: { expectedVersion, expectedCaseVersion, requestKey: randomUUID(), reason: 'Human factual risk review', outcome, ...extra } });
    expect((await review(1, handling.json().version, 'NO_ADDITIONAL_CORE_RISK_CONFIRMED', {}, seedIds.admin)).statusCode).toBe(403);
    const money = await f.prisma.orderPricing.findUniqueOrThrow({ where: { orderId } });
    const held = await review(1, handling.json().version, 'HOLD_UNRESOLVED_RISK');
    expect(held.statusCode, held.body).toBe(200); expect(held.json().reviewPending).toBe(true);
    const current = await f.prisma.exceptionCase.findUniqueOrThrow({ where: { id: entry.id } });
    await notice(2);
    expect((await review(2, current.version, 'NO_ADDITIONAL_CORE_RISK_CONFIRMED')).statusCode).toBe(409);
    const key = randomUUID();
    expect((await review(3, current.version, 'NO_ADDITIONAL_CORE_RISK_CONFIRMED', { requestKey: key })).json().reviewPending).toBe(false);
    expect((await review(3, current.version, 'NO_ADDITIONAL_CORE_RISK_CONFIRMED', { requestKey: key })).statusCode).toBe(200);
    expect(await f.prisma.orderPricing.findUniqueOrThrow({ where: { orderId } })).toEqual(money);
    expect((await f.claim(taskId)).statusCode).toBe(200);
  });

  it('retains original mandatory photos and independent pickup code after a no-added-risk notice and acknowledgement', async () => {
    // Existing frozen constraints remain additional requirements; notice/receipt cannot weaken them.
    await f.prisma.order.update({ where: { id: orderId }, data: { pickupEvidenceLevel: 'REQUIRED', coreFragileValueMinor: 6000, pickupVerificationMode: 'PICKUP_CODE' } });
    const sent = await notice(0); const claimed = await f.claim(taskId); const assignmentId = claimed.json().activeAssignmentId;
    await ack(sent.json().id, assignmentId);
    expect((await pickup(assignmentId)).statusCode).toBe(409);
    const photo = await f.app.inject({ method: 'POST', url: `/orders/${orderId}/evidence`, headers: requestHeaders(f.riders[0]!.userId), payload: { evidenceType: 'RIDER_PICKUP_PHOTO', media: { fileName: 'pickup.jpg', contentType: 'image/jpeg' } } });
    expect(photo.statusCode).toBe(201);
    expect((await pickup(assignmentId, { photoEvidenceId: photo.json().id })).statusCode).toBe(409);
    const code = await f.app.inject({ method: 'POST', url: `/delivery-tasks/${taskId}/pickup-code`, headers: requestHeaders(f.riders[0]!.userId), payload: { assignmentId } });
    expect(code.statusCode).toBe(201);
    expect((await pickup(assignmentId, { photoEvidenceId: photo.json().id, codeId: code.json().id, code: code.json().code })).statusCode).toBe(200);
  });

  it('preserves old acknowledgements without giving replacement riders access or inherited receipts', async () => {
    const sent = await notice(0); const claimed = await f.claim(taskId); const assignmentId = claimed.json().activeAssignmentId;
    await ack(sent.json().id, assignmentId);
    const cancelled = await f.app.inject({ method: 'POST', url: `/delivery-tasks/${taskId}/pre-pickup-cancel`, headers: requestHeaders(f.riders[0]!.userId), payload: { reason: 'PERSONAL_EMERGENCY' } });
    expect(cancelled.statusCode, cancelled.body).toBe(200);
    const replacement = await f.claim(taskId, f.riders[1]!.userId); expect(replacement.statusCode).toBe(200);
    expect((await details(f.riders[1]!.userId)).json().notices[0].acknowledgedAt).toBeNull();
    expect((await details(f.riders[0]!.userId)).statusCode).toBe(403);
    expect((await ack(sent.json().id, assignmentId)).statusCode).toBe(403);
  });

  it('rejects cross-store/irrelevant readers, stale keys, extra fields and competing notices', async () => {
    expect((await notice(0, 'UNASSESSED', {}, seedIds.merchantUser)).statusCode).toBe(403);
    expect((await notice(0, 'UNASSESSED', { paidMinor: 100 })).statusCode).toBe(400);
    const key = randomUUID(); const first = await notice(0, 'NO_ADDITIONAL_CORE_FRAGILE', { requestKey: key }); expect(first.statusCode).toBe(201);
    expect((await notice(0, 'NO_ADDITIONAL_CORE_FRAGILE', { requestKey: key })).json().id).toBe(first.json().id);
    expect((await notice(0, 'UNASSESSED', { requestKey: key })).statusCode).toBe(409);
    const results = await Promise.all([notice(1), notice(1)]); expect(results.map((r) => r.statusCode).sort()).toEqual([201, 409]);
    expect((await details(f.riders[1]!.userId)).statusCode).toBe(403);
  });

  it('rejects a real pickup waiting behind a committed unsafe notice under the same order lock', async () => {
    const claimed = await f.claim(taskId);
    let announce!: () => void; let unlock!: () => void;
    const held = new Promise<void>((resolve) => { announce = resolve; });
    const release = new Promise<void>((resolve) => { unlock = resolve; });
    const gated = f.prisma.$extends({ query: { goodsChangeAction: { async create({ args, query }) { const result = await query(args); announce(); await release; return result; } } } });
    const writing = appendChangeNotice(gated as unknown as PrismaClient, { id: f.ownerId, role: 'MERCHANT', merchantId: f.merchantId }, orderId,
      { expectedVersion: 0, requestKey: randomUUID(), content: 'Changed actual goods; value unassessed', riskDeclaration: 'UNASSESSED' });
    await held;
    const picking = pickup(claimed.json().activeAssignmentId);
    try {
      let observed = false;
      for (let i = 0; i < 300; i++) {
        const rows = await f.prisma.$queryRaw<Array<{ waiting: boolean }>>`SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%"Order"%') AS waiting`;
        if (rows[0]?.waiting) { observed = true; break; }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(observed).toBe(true);
    } finally { unlock(); }
    await writing; expect((await picking).statusCode).toBe(409);
    expect(await f.prisma.pickupHandoff.count({ where: { orderId } })).toBe(0);
  });

  it('cannot use generic resolution, legacy refund or merchant termination to bypass risk review', async () => {
    const before = await f.prisma.settlement.findUnique({ where: { orderId } });
    await notice(0, 'ADDITIONAL_CORE_FRAGILE');
    const entry = await f.prisma.exceptionCase.findFirstOrThrow({ where: { orderId } });
    const handling = await f.app.inject({ method: 'POST', url: `/admin/exception-cases/${entry.id}/claim`, headers: requestHeaders(seedIds.operator), payload: { expectedVersion: entry.version } });
    const resolving = (resolutionType: string) => f.app.inject({ method: 'POST', url: `/admin/exception-cases/${entry.id}/resolve`, headers: requestHeaders(seedIds.operator), payload: { expectedVersion: handling.json().version, resolutionType, note: 'Must not bypass risk review' } });
    expect((await resolving('CONTINUE_FULFILLMENT')).statusCode).toBe(409);
    expect((await resolving('REFUND_AND_CLOSE')).statusCode).toBe(409);
    expect((await f.app.inject({ method: 'POST', url: `/admin/orders/${orderId}/exception`, headers: requestHeaders(seedIds.admin), payload: { reason: 'Unsafe legacy termination' } })).statusCode).toBe(409);
    expect((await details()).json().reviewPending).toBe(true);
    expect(await f.prisma.settlement.findUnique({ where: { orderId } })).toEqual(before);
    expect(await f.prisma.compensationObligation.count({ where: { orderId } })).toBe(0);
  });

  it('preserves a legitimate post-pickup report and blocks completion without undoing the recorded handoff', async () => {
    const claimed = await f.claim(taskId); const assignmentId = claimed.json().activeAssignmentId;
    expect((await pickup(assignmentId)).statusCode).toBe(200);
    const reported = await f.app.inject({ method: 'POST', url: `/orders/${orderId}/exceptions`, headers: requestHeaders(f.riders[0]!.userId), payload: { type: 'GOODS_CHANGE_OBJECTION', assignmentId, expectedVersion: 0, requestKey: randomUUID(), description: 'Contents discovered inconsistent after merchant declaration' } });
    expect(reported.statusCode, reported.body).toBe(201);
    const photo = await f.app.inject({ method: 'POST', url: `/orders/${orderId}/evidence`, headers: requestHeaders(f.riders[0]!.userId), payload: { evidenceType: 'DELIVERY_PHOTO', media: { fileName: 'delivery.jpg', contentType: 'image/jpeg' } } });
    expect((await f.app.inject({ method: 'POST', url: `/delivery-tasks/${taskId}/deliver`, headers: requestHeaders(f.riders[0]!.userId), payload: { evidenceId: photo.json().id } })).statusCode).toBe(409);
    expect((await f.prisma.order.findUniqueOrThrow({ where: { id: orderId } })).status).toBe('PICKED_UP');
    expect(await f.prisma.pickupHandoff.count({ where: { orderId } })).toBe(1);
    expect(await f.prisma.riderSettlement.count({ where: { orderId } })).toBe(0);
  });

  it('protects notices against SQL history replacement and retains original evidence after a bound objection', async () => {
    const sent = await notice(0); const claimed = await f.claim(taskId);
    await expect(f.prisma.orderChangeNotice.update({ where: { id: sent.json().id }, data: { content: 'Silent replacement' } })).rejects.toThrow('append-only');
    const photo = await f.app.inject({ method: 'POST', url: `/orders/${orderId}/evidence`, headers: requestHeaders(f.riders[0]!.userId), payload: { evidenceType: 'RIDER_PICKUP_PHOTO', media: { fileName: 'contents.jpg', contentType: 'image/jpeg' } } });
    const response = await f.app.inject({ method: 'POST', url: `/orders/${orderId}/exceptions`, headers: requestHeaders(f.riders[0]!.userId), payload: { type: 'GOODS_CHANGE_OBJECTION', assignmentId: claimed.json().activeAssignmentId, noticeId: sent.json().id, expectedVersion: 1, requestKey: randomUUID(), description: 'Physical contents conflict', evidenceIds: [photo.json().id] } });
    expect(response.statusCode, response.body).toBe(201);
    const event = await f.prisma.exceptionEvent.findFirstOrThrow({ where: { orderId }, include: { evidences: true } });
    expect(event.evidences[0]?.id).toBe(photo.json().id);
  });

  it('keeps a goods-controlled assignment intact when another ordinary delivery exception is reported', async () => {
    const claimed = await f.claim(taskId); const assignmentId = claimed.json().activeAssignmentId;
    await notice(0, 'UNASSESSED');
    const response = await f.app.inject({ method: 'POST', url: `/orders/${orderId}/exceptions`, headers: requestHeaders(f.riders[0]!.userId), payload: { type: 'RIDER_DELIVERY_EXCEPTION', description: 'An additional obstacle during the goods-risk review' } });
    expect(response.statusCode).toBe(201);
    expect((await f.prisma.order.findUniqueOrThrow({ where: { id: orderId } })).status).toBe('CLAIMED');
    expect((await f.prisma.deliveryAssignment.findUniqueOrThrow({ where: { id: assignmentId } })).status).toBe('ACTIVE');
    expect((await pickup(assignmentId)).statusCode).toBe(409);
  });

  it('can resolve verified goods facts while retaining the independently paused preparation gate', async () => {
    const claimed = await f.claim(taskId); const assignmentId = claimed.json().activeAssignmentId;
    const prep = await f.app.inject({ method: 'POST', url: `/orders/${orderId}/exceptions`, headers: requestHeaders(f.riders[0]!.userId), payload: { type: 'MERCHANT_PREPARATION_UNAVAILABLE', assignmentId, expectedVersion: 0, requestKey: randomUUID(), description: 'Merchant unable to prepare' } });
    expect(prep.statusCode).toBe(201); await notice(0, 'UNASSESSED');
    await f.app.inject({ method: 'POST', url: `/merchant/orders/${orderId}/preparation/recover`, headers: requestHeaders(f.ownerId), payload: { expectedVersion: 1, requestKey: randomUUID() } });
    const goodsCase = await f.prisma.exceptionCase.findFirstOrThrow({ where: { orderId, category: 'GOODS_CHANGE_OBJECTION' } });
    const goodsHandler = await f.app.inject({ method: 'POST', url: `/admin/exception-cases/${goodsCase.id}/claim`, headers: requestHeaders(seedIds.operator), payload: { expectedVersion: goodsCase.version } });
    const clear = await f.app.inject({ method: 'POST', url: `/admin/orders/${orderId}/goods-change-review`, headers: requestHeaders(seedIds.operator), payload: { expectedVersion: 1, expectedCaseVersion: goodsHandler.json().version, requestKey: randomUUID(), outcome: 'NO_ADDITIONAL_CORE_RISK_CONFIRMED', reason: 'Verified no added core risk; preparation remains a separate pending decision' } });
    expect(clear.statusCode, clear.body).toBe(200); expect(clear.json().reviewPending).toBe(false);
    expect((await pickup(assignmentId)).statusCode).toBe(409);
    const prepCase = await f.prisma.exceptionCase.findFirstOrThrow({ where: { orderId, category: 'MERCHANT_PREPARATION_UNAVAILABLE' } });
    const prepHandler = await f.app.inject({ method: 'POST', url: `/admin/exception-cases/${prepCase.id}/claim`, headers: requestHeaders(seedIds.operator), payload: { expectedVersion: prepCase.version } });
    const proposal = await f.app.inject({ method: 'POST', url: `/admin/orders/${orderId}/preparation-review`, headers: requestHeaders(seedIds.operator), payload: { expectedVersion: 2, expectedCaseVersion: prepHandler.json().version, requestKey: randomUUID(), outcome: 'REQUEST_RIDER_CONFIRMATION', reason: 'Verified merchant recovery; actual rider must respond' } });
    expect(proposal.statusCode, proposal.body).toBe(200);
    const accepted = await f.app.inject({ method: 'POST', url: `/delivery-tasks/${taskId}/preparation-recovery-response`, headers: requestHeaders(f.riders[0]!.userId), payload: { expectedVersion: 3, assignmentId, requestKey: randomUUID(), accept: true } });
    expect(accepted.statusCode, accepted.body).toBe(200);
    expect((await pickup(assignmentId)).statusCode).toBe(200);
  });

  it('resolves all statements covered by one current goods case and retains each original evidence link', async () => {
    const claimed = await f.claim(taskId); const assignmentId = claimed.json().activeAssignmentId;
    await notice(0, 'UNASSESSED');
    const photo = await f.app.inject({ method: 'POST', url: `/orders/${orderId}/evidence`, headers: requestHeaders(f.riders[0]!.userId), payload: { evidenceType: 'RIDER_PICKUP_PHOTO', media: { fileName: 'contents.jpg', contentType: 'image/jpeg' } } });
    const objection = (expectedVersion: number) => f.app.inject({ method: 'POST', url: `/orders/${orderId}/exceptions`, headers: requestHeaders(f.riders[0]!.userId), payload: { type: 'GOODS_CHANGE_OBJECTION', assignmentId, expectedVersion, requestKey: randomUUID(), description: `Statement ${expectedVersion}`, evidenceIds: [photo.json().id] } });
    expect((await objection(1)).statusCode).toBe(201);
    const bound = await f.prisma.evidence.findUniqueOrThrow({ where: { id: photo.json().id } });
    expect((await objection(2)).statusCode).toBe(201);
    expect((await f.prisma.evidence.findUniqueOrThrow({ where: { id: photo.json().id } })).exceptionEventId).toBe(bound.exceptionEventId);
    const entry = await f.prisma.exceptionCase.findFirstOrThrow({ where: { orderId } });
    const handler = await f.app.inject({ method: 'POST', url: `/admin/exception-cases/${entry.id}/claim`, headers: requestHeaders(seedIds.operator), payload: { expectedVersion: entry.version } });
    const result = await f.app.inject({ method: 'POST', url: `/admin/orders/${orderId}/goods-change-review`, headers: requestHeaders(seedIds.operator), payload: { expectedVersion: 3, expectedCaseVersion: handler.json().version, requestKey: randomUUID(), outcome: 'NO_ADDITIONAL_CORE_RISK_CONFIRMED', reason: 'Latest covered statements and evidence verified' } });
    expect(result.statusCode, result.body).toBe(200);
    expect(await f.prisma.exceptionEvent.count({ where: { orderId, type: 'GOODS_CHANGE_OBJECTION', resolvedAt: null } })).toBe(0);
    expect(await f.prisma.exceptionEvent.count({ where: { orderId, type: 'GOODS_CHANGE_OBJECTION' } })).toBe(3);
  });

  it('can verify goods facts during a pending exit without cancelling that request or clearing its preparation gate', async () => {
    const claimed = await f.claim(taskId); const assignmentId = claimed.json().activeAssignmentId;
    await f.app.inject({ method: 'POST', url: `/orders/${orderId}/exceptions`, headers: requestHeaders(f.riders[0]!.userId), payload: { type: 'MERCHANT_PREPARATION_UNAVAILABLE', assignmentId, expectedVersion: 0, requestKey: randomUUID(), description: 'Cannot prepare' } });
    const requested = await f.app.inject({ method: 'POST', url: `/delivery-tasks/${taskId}/request-preparation-exit`, headers: requestHeaders(f.riders[0]!.userId), payload: { assignmentId, expectedVersion: 1, requestKey: randomUUID(), reason: 'Request reviewed exit' } });
    expect(requested.statusCode).toBe(200);
    await notice(0, 'UNASSESSED');
    const entry = await f.prisma.exceptionCase.findFirstOrThrow({ where: { orderId, category: 'GOODS_CHANGE_OBJECTION' } });
    const handler = await f.app.inject({ method: 'POST', url: `/admin/exception-cases/${entry.id}/claim`, headers: requestHeaders(seedIds.operator), payload: { expectedVersion: entry.version } });
    const clear = await f.app.inject({ method: 'POST', url: `/admin/orders/${orderId}/goods-change-review`, headers: requestHeaders(seedIds.operator), payload: { expectedVersion: 1, expectedCaseVersion: handler.json().version, requestKey: randomUUID(), outcome: 'NO_ADDITIONAL_CORE_RISK_CONFIRMED', reason: 'Only goods risk has been factually checked; exit remains pending' } });
    expect(clear.statusCode, clear.body).toBe(200);
    expect((await pickup(assignmentId)).statusCode).toBe(409);
    expect((await f.prisma.deliveryAssignment.findUniqueOrThrow({ where: { id: assignmentId } })).noFaultExitStatus).toBe('PENDING');
    const preparation = await f.prisma.exceptionCase.findFirstOrThrow({ where: { orderId, category: 'MERCHANT_PREPARATION_UNAVAILABLE' } });
    const exitHandler = await f.app.inject({ method: 'POST', url: `/admin/exception-cases/${preparation.id}/claim`, headers: requestHeaders(seedIds.operator), payload: { expectedVersion: preparation.version } });
    const released = await f.app.inject({ method: 'POST', url: `/admin/orders/${orderId}/preparation-exit-review`, headers: requestHeaders(seedIds.operator), payload: { assignmentId, expectedVersion: 2, expectedCaseVersion: exitHandler.json().version, requestKey: randomUUID(), approve: true, reason: 'Authorized exit after both facts were examined' } });
    expect(released.statusCode, released.body).toBe(200);
    expect((await f.prisma.deliveryAssignment.findUniqueOrThrow({ where: { id: assignmentId } })).noFaultExitStatus).toBe('APPROVED');
    expect((await f.claim(taskId, f.riders[1]!.userId)).statusCode).toBe(409);
  });

  it('does not leak new goods declarations to a former rider through the shared timeline', async () => {
    await f.claim(taskId);
    await f.app.inject({ method: 'POST', url: `/delivery-tasks/${taskId}/pre-pickup-cancel`, headers: requestHeaders(f.riders[0]!.userId), payload: { reason: 'PERSONAL_EMERGENCY' } });
    await f.claim(taskId, f.riders[1]!.userId);
    await notice(0, 'UNASSESSED', { content: 'Private later goods declaration' });
    const timeline = (user: string) => f.app.inject({ method: 'GET', url: `/orders/${orderId}/timeline`, headers: requestHeaders(user) });
    expect((await timeline(f.riders[1]!.userId)).body).toContain('Private later goods declaration');
    expect((await timeline(f.riders[0]!.userId)).body).not.toContain('Private later goods declaration');
  });
});
