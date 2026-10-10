import type { PickupCustodyDispute, Prisma, PrismaClient } from '@prisma/client';
import type { Actor } from '../auth/auth.js';
import { requireAdminLevel } from '../auth/auth.js';
import { badRequest, conflict, forbidden, notFound } from '../shared/errors.js';
import { openExceptionCase } from '../exception-cases/service.js';
import { assertExceptionCaseAction } from '../exception-cases/state-machine.js';
import { lockPickupOrder } from './pickup-code.js';
import { recordCatalogRiskReport, type CatalogRiskInput } from '../catalog/risk-correction.js';

export type PickupDisputeInput = { assignmentId: string; handoffId: string; reason: string; evidenceIds?: string[]; catalogRiskClaim?: Omit<CatalogRiskInput, 'assignmentId' | 'reason' | 'evidenceIds'> };
export const disputeView = (d: PickupCustodyDispute) => ({ id: d.id, caseId: d.caseId, handoffId: d.handoffId, status: d.status, version: d.version, reason: d.reason, evidenceIds: d.evidenceIds, catalogRiskClaim: d.catalogRiskClaim, merchantAcknowledgedAt: d.merchantAcknowledgedAt, merchantNote: d.merchantNote, resolutionNote: d.resolutionNote, createdAt: d.createdAt, resolvedAt: d.resolvedAt });

export async function disputePickup(prisma: PrismaClient, actor: Actor, taskId: string, input: PickupDisputeInput, now = new Date()) {
  if (actor.role !== 'RIDER' || !actor.riderId) throw forbidden();
  if (!input.reason.trim() || input.reason.length > 500) throw badRequest('INVALID_DISPUTE_REASON', 'Explain the pickup dispute');
  const evidenceIds = [...new Set(input.evidenceIds ?? [])].sort();
  return prisma.$transaction(async (tx) => {
    const identity = await tx.deliveryTask.findUnique({ where: { id: taskId }, select: { orderId: true } });
    if (!identity) throw notFound('Delivery task');
    const task = await lockPickupOrder(tx, identity.orderId);
    const assignment = await tx.deliveryAssignment.findUnique({ where: { id: input.assignmentId } });
    if (!assignment || assignment.taskId !== task.id || assignment.riderId !== actor.riderId) throw forbidden();
    const handoff = await tx.pickupHandoff.findUnique({ where: { id: input.handoffId } });
    if (!handoff || handoff.orderId !== task.orderId || handoff.assignmentId !== assignment.id) throw forbidden();
    const existing = await tx.pickupCustodyDispute.findUnique({ where: { handoffId: handoff.id } });
    if (existing) {
      const originalClaim = existing.catalogRiskClaim as { orderItemId?: string; observedCategoryCode?: string } | null;
      if (existing.reason !== input.reason || JSON.stringify(existing.evidenceIds) !== JSON.stringify(evidenceIds) || originalClaim?.orderItemId !== input.catalogRiskClaim?.orderItemId || originalClaim?.observedCategoryCode !== input.catalogRiskClaim?.observedCategoryCode) throw conflict('DISPUTE_IDEMPOTENCY_CONFLICT', 'This handoff already has a different dispute');
      return disputeView(existing);
    }
    if (assignment.status !== 'ACTIVE' || task.riderId !== actor.riderId || task.status !== 'PICKED_UP' || task.order.status !== 'PICKED_UP' || handoff.revision !== task.order.pickupHandoffRevision) throw conflict('PICKUP_DISPUTE_NOT_ALLOWED', 'Only the current handoff can be disputed before delivery');
    if (await tx.riderSettlement.count({ where: { orderId: task.orderId } }) || await tx.compensationObligation.count({ where: { orderId: task.orderId } })) throw conflict('PICKUP_FINANCIAL_STATE_CONFLICT', 'Existing economic disposition requires separate review');
    if (evidenceIds.length > 10 || (evidenceIds.length && await tx.evidence.count({ where: { id: { in: evidenceIds }, orderId: task.orderId, actorId: actor.id } }) !== evidenceIds.length)) throw badRequest('INVALID_DISPUTE_EVIDENCE', 'Evidence must belong to this order and rider');
    if (input.catalogRiskClaim) {
      const item = await tx.orderItem.findFirst({ where: { id: input.catalogRiskClaim.orderItemId, orderId: task.orderId } });
      if (!item || item.coreFragileSnapshot || !['CAKE', 'SUNDAE'].includes(input.catalogRiskClaim.observedCategoryCode)) throw badRequest('INVALID_CATALOG_CLAIM', 'Report a sold item missing its core category');
    }
    const event = await tx.exceptionEvent.create({ data: { orderId: task.orderId, reporterId: actor.id, reporterRole: 'RIDER', orderStatus: 'PICKED_UP', type: 'PICKUP_CUSTODY_DISPUTE', description: input.reason, createdAt: now } });
    const exceptionCase = await openExceptionCase(tx, event);
    const dispute = await tx.pickupCustodyDispute.create({ data: { orderId: task.orderId, handoffId: handoff.id, caseId: exceptionCase.id, reason: input.reason, evidenceIds, ...(input.catalogRiskClaim ? { catalogRiskClaim: input.catalogRiskClaim } : {}), createdAt: now } });
    await tx.orderEvent.create({ data: { orderId: task.orderId, eventType: 'EXCEPTION_RECORDED', operatorId: actor.id, operatorRole: 'RIDER', fromStatus: 'PICKED_UP', toStatus: 'PICKED_UP', reason: input.reason, metadata: { action: 'PICKUP_DENIED', disputeId: dispute.id, handoffId: handoff.id, merchantEventId: handoff.eventId, assignmentId: assignment.id, evidenceIds, caseId: exceptionCase.id, custodyReleased: false, ordinaryCancellationCounted: false } } });
    return disputeView(dispute);
  });
}

export async function acknowledgePickupMistake(prisma: PrismaClient, actor: Actor, orderId: string, disputeId: string, expectedVersion: number, note: string) {
  if (actor.role !== 'MERCHANT' || !actor.merchantId) throw forbidden();
  return prisma.$transaction(async (tx) => {
    const task = await lockPickupOrder(tx, orderId);
    if (task.order.merchantId !== actor.merchantId) throw forbidden();
    const dispute = await tx.pickupCustodyDispute.findFirst({ where: { id: disputeId, orderId } });
    if (!dispute) throw notFound('Own pickup dispute');
    if (!['OPEN', 'INCONCLUSIVE'].includes(dispute.status) || task.status !== 'PICKED_UP' || task.order.status !== 'PICKED_UP') throw conflict('PICKUP_DISPUTE_TERMINAL', 'This dispute is no longer awaiting facts');
    if (dispute.merchantAcknowledgedAt && dispute.merchantNote === note) return disputeView(dispute);
    if (dispute.version !== expectedVersion) throw conflict('DISPUTE_VERSION_CONFLICT', 'Dispute changed');
    const updated = await tx.pickupCustodyDispute.update({ where: { id: dispute.id }, data: { merchantAcknowledgedAt: new Date(), merchantNote: note, version: { increment: 1 } } });
    await tx.orderEvent.create({ data: { orderId, eventType: 'EXCEPTION_RECORDED', operatorId: actor.id, operatorRole: 'MERCHANT', fromStatus: task.order.status, toStatus: task.order.status, reason: note, metadata: { action: 'MERCHANT_ACKNOWLEDGED_NO_HANDOFF', disputeId, goodsRemainAtMerchant: true } } });
    return disputeView(updated);
  });
}

export type ResolvePickupInput = { expectedVersion: number; expectedCaseVersion: number; requestKey: string; outcome: 'NOT_HANDED_OVER' | 'HANDED_OVER' | 'INCONCLUSIVE'; note: string };
export async function resolvePickupDispute(prisma: PrismaClient, actor: Actor, disputeId: string, input: ResolvePickupInput, now = new Date()) {
  requireAdminLevel(actor, ['OPERATOR', 'SUPER_ADMIN']);
  return prisma.$transaction(async (tx) => {
    const identity = await tx.pickupCustodyDispute.findUnique({ where: { id: disputeId }, select: { caseId: true, orderId: true } });
    if (!identity) throw notFound('Pickup dispute');
    // Existing case workflow locks precede Order -> Task; no settlement locks are needed.
    await tx.$queryRaw`SELECT "id" FROM "ExceptionCase" WHERE "id" = ${identity.caseId}::uuid FOR UPDATE`;
    const task = await lockPickupOrder(tx, identity.orderId);
    const dispute = await tx.pickupCustodyDispute.findUniqueOrThrow({ where: { id: disputeId }, include: { case: true, handoff: true } });
    if (dispute.case.currentHandlerAdminId !== actor.id) throw forbidden();
    if (dispute.resolutionKey === input.requestKey) {
      if (dispute.status !== input.outcome || dispute.resolutionNote !== input.note || dispute.resolvedFromVersion !== input.expectedVersion) throw conflict('DISPUTE_IDEMPOTENCY_CONFLICT', 'Resolution retry differs');
      return disputeView(dispute);
    }
    assertExceptionCaseAction(dispute.case.status, 'RESOLVE');
    if (!['OPEN', 'INCONCLUSIVE'].includes(dispute.status) || dispute.version !== input.expectedVersion || dispute.case.version !== input.expectedCaseVersion || task.status !== 'PICKED_UP' || task.order.status !== 'PICKED_UP' || dispute.handoff.revision !== task.order.pickupHandoffRevision || !task.assignments.some((a) => a.id === dispute.handoff.assignmentId && a.riderId === task.riderId)) throw conflict('PICKUP_RESOLUTION_STATE_CONFLICT', 'Current dispute, case, handoff or assignment changed');
    if (await tx.riderSettlement.count({ where: { orderId: task.orderId } }) || await tx.compensationObligation.count({ where: { orderId: task.orderId } })) throw conflict('PICKUP_FINANCIAL_STATE_CONFLICT', 'Cannot correct existing economic disposition');
    if (input.outcome === 'NOT_HANDED_OVER') {
      if (await tx.exceptionCase.count({ where: { orderId: task.orderId, category: { in: ['SEVERE_FOOD_DAMAGE', 'FOOD_LOST'] } } })) throw conflict('CONFLICTING_SEVERE_FACTS', 'Review severe custody facts before correcting pickup');
      // Dedicated audited correction only; ordinary state machine still forbids rollback.
      await tx.order.update({ where: { id: task.orderId }, data: { status: 'CLAIMED', pickupHandoffRevision: { increment: 1 } } });
      await tx.deliveryTask.update({ where: { id: task.id }, data: { status: 'CLAIMED', pickedUpAt: null } });
      await tx.verificationCode.updateMany({ where: { orderId: task.orderId, purpose: 'PICKUP', invalidatedAt: null }, data: { invalidatedAt: now } });
      await tx.orderEvent.create({ data: { orderId: task.orderId, eventType: 'EXCEPTION_RECORDED', operatorId: actor.id, operatorRole: 'ADMIN', fromStatus: 'PICKED_UP', toStatus: 'CLAIMED', reason: input.note, metadata: { action: 'PICKUP_STATUS_CORRECTED', disputeId, handoffId: dispute.handoffId, assignmentId: dispute.handoff.assignmentId, previousRevision: task.order.pickupHandoffRevision, newRevision: task.order.pickupHandoffRevision + 1, originalMerchantEventRetained: true } } });
      if (dispute.catalogRiskClaim) {
        const risk = dispute.catalogRiskClaim as { orderItemId: string; observedCategoryCode: 'CAKE' | 'SUNDAE' };
        const responsible = task.assignments.find((a) => a.id === dispute.handoff.assignmentId)!;
        await recordCatalogRiskReport(tx, { id: responsible.rider.userId, role: 'RIDER', riderId: responsible.riderId }, task.id, { assignmentId: responsible.id, ...risk, reason: dispute.reason, evidenceIds: dispute.evidenceIds }, now, actor);
      }
    }
    const unresolved = input.outcome === 'INCONCLUSIVE';
    const updated = await tx.pickupCustodyDispute.update({ where: { id: disputeId }, data: { status: input.outcome, version: { increment: 1 }, resolutionNote: input.note, resolutionKey: input.requestKey, resolvedFromVersion: input.expectedVersion, resolvedAt: unresolved ? null : now } });
    await tx.exceptionCase.update({ where: { id: dispute.caseId }, data: { status: unresolved ? 'WAITING_FOR_PARTICIPANT' : 'RESOLVED', resolutionType: unresolved ? 'WAITING_FOR_INFORMATION' : 'CONTINUE_FULFILLMENT', resolutionNote: input.note, resolvedAt: unresolved ? null : now, lastActionAt: now, version: { increment: 1 } } });
    if (!unresolved) await tx.exceptionEvent.update({ where: { id: dispute.case.exceptionEventId }, data: { resolvedAt: now } });
    const metadata: Prisma.InputJsonObject = { action: 'PICKUP_CUSTODY_REVIEWED', disputeId, handoffId: dispute.handoffId, assignmentId: dispute.handoff.assignmentId, requestKey: input.requestKey, outcome: input.outcome, physicalHandoffProvenByButton: false, originalMerchantEventRetained: true, liabilityOrMoneyChanged: false };
    const correctedOrder = await tx.order.findUniqueOrThrow({ where: { id: task.orderId }, select: { status: true } });
    await tx.orderEvent.create({ data: { orderId: task.orderId, eventType: 'EXCEPTION_RECORDED', operatorId: actor.id, operatorRole: 'ADMIN', fromStatus: correctedOrder.status, toStatus: correctedOrder.status, reason: input.note, metadata } });
    await tx.exceptionCaseAction.create({ data: { caseId: dispute.caseId, type: unresolved ? 'REQUESTED_INFORMATION' : 'RESOLVED', actorId: actor.id, reason: input.note, metadata } });
    return disputeView(updated);
  });
}
