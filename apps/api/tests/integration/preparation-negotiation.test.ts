import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { preparationFixture, requestHeaders } from './preparation-fixture.js';
import { seedIds } from '../../prisma/seed.js';
import { recordNegotiationStatement } from '../../src/orders/preparation-negotiation.js';
import type { PrismaClient } from '@prisma/client';

describe('whole-order negotiation is separate from refund success and termination', () => {
  let f: Awaited<ReturnType<typeof preparationFixture>>;
  let orderId: string; let taskId: string; let amount: number;
  beforeAll(async () => { f = await preparationFixture(); });
  beforeEach(async () => {
    await f.clearOrders(); ({ orderId, taskId } = await f.published());
    const price = await f.prisma.orderPricing.findUniqueOrThrow({ where: { orderId } });
    amount = price.itemSubtotalMinor + price.customerDeliveryFeeMinor + price.customerRiderTipMinor;
    const unable = await f.app.inject({ method: 'POST', url: `/merchant/orders/${orderId}/preparation/unable`, headers: requestHeaders(f.ownerId), payload: { expectedVersion: 0, requestKey: randomUUID(), reason: 'The whole order cannot be prepared' } });
    expect(unable.statusCode).toBe(200);
  });
  afterAll(async () => { await f.close(); });
  const statement = (user: string, expectedVersion: number, kind: string, extra = {}) => f.app.inject({ method: 'POST', url: `/orders/${orderId}/preparation-negotiation/statements`, headers: requestHeaders(user), payload: { expectedVersion, requestKey: randomUUID(), kind, text: 'Participant statement only', ...extra } });
  const view = (user: string = seedIds.customer) => f.app.inject({ method: 'GET', url: `/orders/${orderId}/preparation-negotiation`, headers: requestHeaders(user) });
  const propose = (expectedVersion = 0, refundMinor = amount, extra = {}) => statement(f.ownerId, expectedVersion, 'PROPOSE', { wholeOrderUnavailable: true, refundMinor, ...extra });
  async function bothConfirm() {
    expect((await propose()).statusCode).toBe(201);
    expect((await statement(f.ownerId, 1, 'CONFIRM', { proposalVersion: 1, refundMinor: amount })).statusCode).toBe(201);
    expect((await statement(seedIds.customer, 2, 'CONFIRM', { proposalVersion: 1, refundMinor: amount })).statusCode).toBe(201);
  }
  async function handler() {
    const entry = await f.prisma.exceptionCase.findFirstOrThrow({ where: { orderId, category: 'MERCHANT_PREPARATION_UNAVAILABLE' } });
    const response = await f.app.inject({ method: 'POST', url: `/admin/exception-cases/${entry.id}/claim`, headers: requestHeaders(seedIds.operator), payload: { expectedVersion: entry.version } });
    expect(response.statusCode).toBe(200); return { id: entry.id, version: response.json().version as number };
  }
  const review = (expectedVersion: number, expectedCaseVersion: number, outcome: string, extra = {}, user: string = seedIds.operator) => f.app.inject({ method: 'POST', url: `/admin/orders/${orderId}/preparation-negotiation-review`, headers: requestHeaders(user), payload: { expectedVersion, expectedCaseVersion, expectedPreparationVersion: 2, requestKey: randomUUID(), outcome, reason: 'Authorized human factual review', ...extra } });

  it('requires both explicit confirmations of the same proposal and separates all real-funds facts', async () => {
    await bothConfirm();
    const result = (await view()).json();
    expect(result).toMatchObject({ version: 3, agreementEstablished: true, refundBusinessApproved: false, refundInitiated: false, trustedExternalRefundConfirmed: false, formalTerminationAvailable: false });
    expect(result.agreementStatements).toHaveLength(3); expect(result.refundProgress).toEqual([]);
    expect((await f.claim(taskId)).statusCode).toBe(409);
    expect((await f.prisma.order.findUniqueOrThrow({ where: { id: orderId } })).status).toBe('READY_FOR_RIDER');
  });

  it('never lets self-reported sent/received create payment success, refunds, earned income or closure', async () => {
    const price = await f.prisma.orderPricing.findUniqueOrThrow({ where: { orderId } });
    const settlement = await f.prisma.settlement.findUnique({ where: { orderId } });
    await bothConfirm();
    expect((await statement(f.ownerId, 3, 'REFUND_SENT', { proposalVersion: 1, refundMinor: amount, text: 'I say I sent a refund' })).statusCode).toBe(201);
    expect((await statement(seedIds.customer, 4, 'REFUND_RECEIVED', { proposalVersion: 1, refundMinor: amount, text: 'I report receipt, not trusted provider proof' })).statusCode).toBe(201);
    const result = (await view()).json(); expect(result.refundProgress).toHaveLength(2);
    expect(result).toMatchObject({ trustedExternalRefundConfirmed: false, refundInitiated: false, formalTerminationAvailable: false });
    const current = await handler(); const checked = await review(5, current.version, 'SIMPLIFIED_WAITING_FOR_FUNDS');
    expect(checked.statusCode, checked.body).toBe(200); expect(checked.json().reviewRoute).toBe('SIMPLIFIED_WAITING_FOR_FUNDS');
    expect(await f.prisma.orderPricing.findUniqueOrThrow({ where: { orderId } })).toEqual(price);
    expect(await f.prisma.settlement.findUnique({ where: { orderId } })).toEqual(settlement);
    expect(await f.prisma.riderSettlement.count({ where: { orderId } })).toBe(0);
    expect(await f.prisma.compensationObligation.count({ where: { orderId } })).toBe(0);
  });

  it('invalidates old confirmations on a new proposal and keeps contradictory amounts in ordinary review', async () => {
    await bothConfirm(); await propose(3);
    expect((await view()).json().agreementEstablished).toBe(false);
    expect((await statement(seedIds.customer, 4, 'CONFIRM', { proposalVersion: 1, refundMinor: amount })).statusCode).toBe(409);
    await statement(f.ownerId, 4, 'CONFIRM', { proposalVersion: 4, refundMinor: amount });
    await statement(seedIds.customer, 5, 'CONFIRM', { proposalVersion: 4, refundMinor: amount + 1 });
    expect((await view()).json().agreementEstablished).toBe(false);
    const current = await handler(); expect((await review(6, current.version, 'SIMPLIFIED_WAITING_FOR_FUNDS')).statusCode).toBe(409);
    const ordinary = await review(6, current.version, 'REGULAR_REVIEW'); expect(ordinary.statusCode).toBe(200);
    expect(ordinary.json().reviewRoute).toBe('REGULAR_REVIEW');
  });

  it('guards handler, versions, escalation and idempotent human review without terminal shortcuts', async () => {
    await bothConfirm(); const current = await handler(); const key = randomUUID();
    expect((await review(3, current.version, 'SIMPLIFIED_WAITING_FOR_FUNDS', {}, seedIds.admin)).statusCode).toBe(403);
    expect((await review(2, current.version, 'SIMPLIFIED_WAITING_FOR_FUNDS')).statusCode).toBe(409);
    expect((await review(3, current.version, 'SIMPLIFIED_WAITING_FOR_FUNDS', { requestKey: key })).statusCode).toBe(200);
    expect((await review(3, current.version, 'SIMPLIFIED_WAITING_FOR_FUNDS', { requestKey: key })).statusCode).toBe(200);
    const entry = await f.prisma.exceptionCase.findUniqueOrThrow({ where: { id: current.id } });
    await f.app.inject({ method: 'POST', url: `/admin/exception-cases/${entry.id}/escalate`, headers: requestHeaders(seedIds.operator), payload: { expectedVersion: entry.version, reason: 'Funding verification requires lawful superior review' } });
    expect((await review(4, entry.version + 1, 'REGULAR_REVIEW')).statusCode).toBe(409);
    expect((await f.app.inject({ method: 'POST', url: `/admin/exception-cases/${entry.id}/resolve`, headers: requestHeaders(seedIds.admin), payload: { expectedVersion: entry.version + 1, resolutionType: 'REFUND_AND_CLOSE', note: 'No trusted funds facts' } })).statusCode).toBe(409);
  });

  it('rejects unrelated writers, fake funds fields and wrong-role refund statements; preserves append history and retries', async () => {
    expect((await statement(seedIds.merchantUser, 0, 'PROPOSE', { wholeOrderUnavailable: true, refundMinor: amount })).statusCode).toBe(403);
    expect((await propose(0, amount, { providerSucceeded: true })).statusCode).toBe(400);
    const key = randomUUID(); const results = await Promise.all([propose(0, amount, { requestKey: key }), propose(0, amount, { requestKey: key })]);
    expect(results.map((r) => r.statusCode)).toEqual([201, 201]); expect((await view()).json().agreementStatements).toHaveLength(1);
    expect((await statement(seedIds.customer, 1, 'REFUND_SENT', { proposalVersion: 1, refundMinor: amount })).statusCode).toBe(403);
    for (const field of ['actorId', 'requestKey', 'payloadSignature', 'caseId', 'merchantDeliveryContributionMinor', 'platformSubsidyMinor']) expect((await view()).body).not.toContain(`"${field}":`);
    expect((await view(f.riders[0]!.userId)).statusCode).toBe(403);
  });

  it('marks a prior human review stale when later participant facts disagree, and cannot reopen through ordinary recovery', async () => {
    await bothConfirm(); const current = await handler();
    expect((await review(3, current.version, 'SIMPLIFIED_WAITING_FOR_FUNDS')).statusCode).toBe(200);
    expect((await statement(seedIds.customer, 4, 'DISPUTE', { proposalVersion: 1, text: 'I no longer confirm these terms' })).statusCode).toBe(201);
    expect((await view()).json()).toMatchObject({ agreementEstablished: false, reviewRoute: 'REVIEW_STALE', reviewCurrent: false });
    const recovering = await f.app.inject({ method: 'POST', url: `/merchant/orders/${orderId}/preparation/recover`, headers: requestHeaders(f.ownerId), payload: { expectedVersion: 2, requestKey: randomUUID() } });
    expect(recovering.json().state).toBe('MANUAL_REVIEW');
    const entry = await f.prisma.exceptionCase.findUniqueOrThrow({ where: { id: current.id } });
    const bypass = await f.app.inject({ method: 'POST', url: `/admin/orders/${orderId}/preparation-review`, headers: requestHeaders(seedIds.operator), payload: { expectedVersion: 3, expectedCaseVersion: entry.version, requestKey: randomUUID(), outcome: 'ALLOW_UNCLAIMED_RECOVERY', reason: 'Must not bypass unresolved negotiation and funding facts' } });
    expect(bypass.statusCode).toBe(409);
  });

  it('routes refund-progress amount conflicts to ordinary review even when terms were mutually confirmed', async () => {
    await bothConfirm();
    await statement(f.ownerId, 3, 'REFUND_SENT', { proposalVersion: 1, refundMinor: amount - 1 });
    const current = await handler();
    expect((await review(4, current.version, 'SIMPLIFIED_WAITING_FOR_FUNDS')).statusCode).toBe(409);
    expect((await review(4, current.version, 'REGULAR_REVIEW')).statusCode).toBe(200);
    expect((await view()).json().trustedExternalRefundConfirmed).toBe(false);
  });

  it('preserves prior rider rights and excludes any assignment history from simplified review', async () => {
    await f.app.inject({ method: 'POST', url: `/merchant/orders/${orderId}/preparation/recover`, headers: requestHeaders(f.ownerId), payload: { expectedVersion: 1, requestKey: randomUUID() } });
    const claimed = await f.claim(taskId); expect(claimed.statusCode).toBe(200);
    await f.app.inject({ method: 'POST', url: `/merchant/orders/${orderId}/preparation/unable`, headers: requestHeaders(f.ownerId), payload: { expectedVersion: 2, requestKey: randomUUID(), reason: 'Whole-order inability discovered later' } });
    expect((await propose()).statusCode).toBe(409);
    await f.app.inject({ method: 'POST', url: `/delivery-tasks/${taskId}/pre-pickup-cancel`, headers: requestHeaders(f.riders[0]!.userId), payload: { reason: 'PERSONAL_EMERGENCY' } });
    const assignment = await f.prisma.deliveryAssignment.findUniqueOrThrow({ where: { id: claimed.json().activeAssignmentId } });
    await bothConfirm(); const current = await handler();
    const prep = (await view()).json().preparationVersion;
    expect((await review(3, current.version, 'SIMPLIFIED_WAITING_FOR_FUNDS', { expectedPreparationVersion: prep })).statusCode).toBe(409);
    expect((await review(3, current.version, 'REGULAR_REVIEW', { expectedPreparationVersion: prep })).statusCode).toBe(200);
    expect(await f.prisma.deliveryAssignment.findUniqueOrThrow({ where: { id: assignment.id } })).toEqual(assignment);
  });

  it('uses actual order locking so a queued review cannot approve older participant facts', async () => {
    await bothConfirm(); const current = await handler();
    let announce!: () => void; let unlock!: () => void;
    const held = new Promise<void>((resolve) => { announce = resolve; }); const release = new Promise<void>((resolve) => { unlock = resolve; });
    const gated = f.prisma.$extends({ query: { preparationNegotiationRecord: { async create({ args, query }) { const result = await query(args); announce(); await release; return result; } } } });
    const writing = recordNegotiationStatement(gated as unknown as PrismaClient, { id: seedIds.customer, role: 'CUSTOMER' }, orderId,
      { kind: 'DISPUTE', expectedVersion: 3, proposalVersion: 1, requestKey: randomUUID(), text: 'Concurrent disagreement' });
    await held; const checking = review(3, current.version, 'SIMPLIFIED_WAITING_FOR_FUNDS');
    try {
      let observed = false;
      for (let i = 0; i < 300; i++) {
        const rows = await f.prisma.$queryRaw<Array<{ waiting: boolean }>>`SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%"Order"%') AS waiting`;
        if (rows[0]?.waiting) { observed = true; break; }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(observed).toBe(true);
    } finally { unlock(); }
    await writing; expect((await checking).statusCode).toBe(409);
    expect((await view()).json().agreementEstablished).toBe(false);
  });

  it('does not overwrite records or reopen a legacy terminal source case, and rejects competing proposals', async () => {
    const results = await Promise.all([propose(), propose()]); expect(results.map((r) => r.statusCode).sort()).toEqual([201, 409]);
    const record = await f.prisma.preparationNegotiationRecord.findFirstOrThrow({ where: { orderId } });
    await expect(f.prisma.preparationNegotiationRecord.update({ where: { id: record.id }, data: { text: 'Silent rewrite' } })).rejects.toThrow('append-only');
    const current = await handler();
    // Represent an already terminal historical case; new endpoints must never reopen it.
    await f.prisma.exceptionCase.update({ where: { id: current.id }, data: { status: 'CLOSED', version: { increment: 1 } } });
    expect((await statement(seedIds.customer, 1, 'CONFIRM', { proposalVersion: 1, refundMinor: amount })).statusCode).toBe(409);
    expect((await review(1, current.version + 1, 'REGULAR_REVIEW')).statusCode).toBe(409);
    expect(await f.prisma.exceptionCase.count({ where: { orderId } })).toBe(1);
  });

  it.each(['RECOVERY', 'ESCALATION', 'OTHER_CASE'])('invalidates current simplified review after %s while preserving history', async (change) => {
    await bothConfirm(); const current = await handler();
    expect((await review(3, current.version, 'SIMPLIFIED_WAITING_FOR_FUNDS')).statusCode).toBe(200);
    expect((await view()).json().reviewCurrent).toBe(true);
    if (change === 'RECOVERY') await f.app.inject({ method: 'POST', url: `/merchant/orders/${orderId}/preparation/recover`, headers: requestHeaders(f.ownerId), payload: { expectedVersion: 2, requestKey: randomUUID() } });
    if (change === 'ESCALATION') await f.app.inject({ method: 'POST', url: `/admin/exception-cases/${current.id}/escalate`, headers: requestHeaders(seedIds.operator), payload: { expectedVersion: current.version + 1, reason: 'Requires lawful superior takeover' } });
    if (change === 'OTHER_CASE') await f.app.inject({ method: 'POST', url: `/orders/${orderId}/exceptions`, headers: requestHeaders(seedIds.customer), payload: { type: 'OTHER_NEEDS_REVIEW', description: 'Separate unresolved facts' } });
    const result = (await view()).json(); expect(result).toMatchObject({ reviewCurrent: false, reviewRoute: 'REVIEW_STALE', formalTerminationAvailable: false });
    expect(result.reviewHistory).toHaveLength(1);
  });

  it('publishes the safe protocol in OpenAPI and rejects coerced money, injected identity/time and partial-order scope', async () => {
    const api = f.app.swagger() as { paths: Record<string, unknown> };
    expect(api.paths['/orders/{orderId}/preparation-negotiation/statements']).toBeDefined();
    expect(api.paths['/admin/orders/{orderId}/preparation-negotiation-review']).toBeDefined();
    expect((await propose(0, amount, { actorId: seedIds.admin })).statusCode).toBe(400);
    expect((await propose(0, amount, { createdAt: new Date().toISOString() })).statusCode).toBe(400);
    expect((await propose(0, amount, { wholeOrderUnavailable: false })).statusCode).toBe(400);
    expect((await propose(0, amount, { refundMinor: String(amount) })).statusCode).toBe(400);
  });

  it('requires participant statements before creating a negotiation review record', async () => {
    const escalated = await f.app.inject({ method: 'POST', url: `/orders/${orderId}/preparation-escalate`, headers: requestHeaders(seedIds.customer), payload: { expectedVersion: 1, requestKey: randomUUID(), reason: 'Ordinary manual preparation review without negotiation' } });
    expect(escalated.statusCode).toBe(200);
    const current = await handler();
    expect((await review(0, current.version, 'REGULAR_REVIEW')).statusCode).toBe(409);
    expect((await view()).json().reviewHistory).toEqual([]);
  });
});
