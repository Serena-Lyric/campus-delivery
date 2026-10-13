import type { PrismaClient } from '@prisma/client';
import { Type } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { requireAdminLevel, type Actor } from '../auth/auth.js';
import { badRequest, conflict, forbidden } from '../shared/errors.js';
import { assertExceptionCaseAction } from '../exception-cases/state-machine.js';
import { ensurePreparationCase, lockPreparationOrder, preparationControlView, preparationUuid } from './preparation-control.js';

export const PreparationReviewBody = Type.Object({ expectedVersion: Type.Integer({ minimum: 0 }), expectedCaseVersion: Type.Integer({ minimum: 0 }), requestKey: preparationUuid(),
  outcome: Type.Union([Type.Literal('REQUEST_RIDER_CONFIRMATION'), Type.Literal('ALLOW_UNCLAIMED_RECOVERY'), Type.Literal('KEEP_PAUSED')]),
  reason: Type.String({ minLength: 1, maxLength: 500, pattern: '\\S' }) }, { additionalProperties: false });
export type PreparationReviewInput = { expectedVersion: number; expectedCaseVersion: number; requestKey: string; outcome: 'REQUEST_RIDER_CONFIRMATION' | 'ALLOW_UNCLAIMED_RECOVERY' | 'KEEP_PAUSED'; reason: string };

export async function reviewPreparationControl(prisma: PrismaClient, actor: Actor, orderId: string, input: PreparationReviewInput, clock = () => new Date()) {
  requireAdminLevel(actor, ['OPERATOR', 'SUPER_ADMIN']);
  if (!Value.Check(PreparationReviewBody, input)) throw badRequest('INVALID_PREPARATION_REVIEW', 'Invalid review fields');
  return prisma.$transaction(async (tx) => {
    const order = await lockPreparationOrder(tx, orderId);
    const linked = await ensurePreparationCase(tx, order);
    await tx.$queryRaw`SELECT "id" FROM "ExceptionCase" WHERE "id"=${linked.id}::uuid FOR UPDATE`;
    const current = await tx.exceptionCase.findUniqueOrThrow({ where: { id: linked.id } });
    if (current.currentHandlerAdminId !== actor.id) throw forbidden();
    if (current.category !== 'MERCHANT_PREPARATION_UNAVAILABLE' || !['CREATED', 'MERCHANT_PENDING', 'READY_FOR_RIDER', 'CLAIMED'].includes(order.status) || order.deliveryTask?.pickedUpAt) throw conflict('PREPARATION_REVIEW_NOT_AVAILABLE', 'Only the current pre-pickup preparation case may use this review');
    const signature = JSON.stringify({ outcome: input.outcome, expectedVersion: input.expectedVersion, expectedCaseVersion: input.expectedCaseVersion, reason: input.reason });
    const prior = await tx.preparationControlAudit.findUnique({ where: { orderId_requestKey: { orderId, requestKey: input.requestKey } } });
    if (prior) {
      if (prior.actorId !== actor.id || prior.payloadSignature !== signature || order.preparationControlVersion !== prior.version || current.version !== input.expectedCaseVersion + 1
        || (input.outcome === 'ALLOW_UNCLAIMED_RECOVERY' ? current.status !== 'RESOLVED' || Boolean(order.deliveryTask?.riderId) : !['IN_PROGRESS', 'WAITING_FOR_PARTICIPANT'].includes(current.status))) throw conflict('PREPARATION_REVIEW_RETRY_CONFLICT', 'Review or workflow changed');
      return preparationControlView(order);
    }
    assertExceptionCaseAction(current.status, 'RESOLVE');
    if (current.version !== input.expectedCaseVersion || order.preparationControlVersion !== input.expectedVersion || order.preparationControlState === 'NORMAL') throw conflict('PREPARATION_REVIEW_VERSION_CONFLICT', 'Refresh the active case and preparation workflow');
    const latestMerchant = await tx.preparationControlAudit.findFirst({ where: { orderId, action: { in: ['DECLARE_UNABLE', 'REQUEST_RECOVERY'] } }, orderBy: { version: 'desc' } });
    if (input.outcome !== 'KEEP_PAUSED' && latestMerchant?.action !== 'REQUEST_RECOVERY') throw conflict('MERCHANT_RECOVERY_REQUIRED', 'A current merchant recovery proposal must precede review');
    if (input.outcome !== 'KEEP_PAUSED' && await tx.exceptionCase.count({ where: { orderId, id: { not: current.id }, status: { notIn: ['RESOLVED', 'CLOSED'] } } })) {
      throw conflict('RECOVERY_OTHER_CASE_PENDING', 'Another unresolved case must be reviewed before a preparation recovery can proceed');
    }
    const now = clock();
    let state = 'MANUAL_REVIEW' as 'MANUAL_REVIEW' | 'RECOVERY_PENDING' | 'NORMAL';
    let reportedAssignmentId = order.preparationReportedAssignmentId;
    if (input.outcome === 'REQUEST_RIDER_CONFIRMATION') {
      const assignment = order.deliveryTask?.assignments.find((a) => a.riderId === order.deliveryTask?.riderId);
      if (!assignment || assignment.noFaultExitStatus === 'PENDING') throw conflict('ACTIVE_RIDER_RESPONSE_REQUIRED', 'The active rider must finish any pending exit review before another recovery proposal');
      state = 'RECOVERY_PENDING';
      reportedAssignmentId = assignment.id;
    } else if (input.outcome === 'ALLOW_UNCLAIMED_RECOVERY') {
      if (order.deliveryTask?.riderId || order.deliveryTask?.assignments.length || (order.deliveryTask?.claimDeadline && now >= order.deliveryTask.claimDeadline)
        || await tx.exceptionCase.count({ where: { orderId, id: { not: current.id }, status: { notIn: ['RESOLVED', 'CLOSED'] } } })) throw conflict('UNCLAIMED_RECOVERY_UNSAFE', 'An unresolved assignment, conflict or passed original deadline prevents recovery');
      state = 'NORMAL';
      reportedAssignmentId = null;
    }
    const updated = await tx.order.update({ where: { id: orderId }, data: { preparationControlState: state, preparationControlVersion: { increment: 1 }, preparationControlUpdatedAt: now, preparationReportedAssignmentId: reportedAssignmentId } });
    const changed = await tx.exceptionCase.updateMany({ where: { id: current.id, version: input.expectedCaseVersion, currentHandlerAdminId: actor.id, status: current.status }, data: {
      version: { increment: 1 }, lastActionAt: now, ...(state === 'NORMAL' ? { status: 'RESOLVED', resolutionType: 'CONTINUE_FULFILLMENT', resolutionNote: input.reason, resolvedAt: now } : {}),
    } });
    if (changed.count !== 1) throw conflict('CASE_VERSION_CONFLICT', 'The handler or case changed');
    if (state === 'NORMAL') await tx.exceptionEvent.update({ where: { id: current.exceptionEventId }, data: { resolvedAt: now } });
    await tx.exceptionCaseAction.create({ data: { caseId: current.id, type: state === 'NORMAL' ? 'RESOLVED' : 'REQUESTED_INFORMATION', actorId: actor.id, reason: input.reason,
      metadata: { action: 'PREPARATION_REVIEW', outcome: input.outcome, orderTerminated: false, moneyChanged: false } } });
    await tx.preparationControlAudit.create({ data: { orderId, version: updated.preparationControlVersion, action: 'ADMIN_PREPARATION_REVIEW', previousState: order.preparationControlState,
      newState: state, actorId: actor.id, requestKey: input.requestKey, payloadSignature: signature, createdAt: now } });
    return preparationControlView(updated);
  });
}
