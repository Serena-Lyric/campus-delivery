import type { PrismaClient } from '@prisma/client';
import { Type } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { requireAdminLevel, type Actor } from '../auth/auth.js';
import { conflict, forbidden, notFound, badRequest } from '../shared/errors.js';
import { assertExceptionCaseAction } from '../exception-cases/state-machine.js';
import { transitionOrder } from './state-machine.js';
import { ensurePreparationCase, lockPreparationOrder, preparationControlView, preparationUuid } from './preparation-control.js';

const fields = { assignmentId: preparationUuid(), expectedVersion: Type.Integer({ minimum: 0, maximum: 2147483646 }), requestKey: preparationUuid(), reason: Type.String({ minLength: 1, maxLength: 500, pattern: '\\S' }) };
export const PreparationExitBody = Type.Object(fields, { additionalProperties: false });
export const PreparationExitReviewBody = Type.Object({ ...fields, expectedCaseVersion: Type.Integer({ minimum: 0, maximum: 2147483646 }), approve: Type.Boolean() }, { additionalProperties: false });
export type ExitInput = { assignmentId: string; expectedVersion: number; requestKey: string; reason: string };
export type ExitReviewInput = ExitInput & { expectedCaseVersion: number; approve: boolean };

export async function requestPreparationExit(prisma: PrismaClient, actor: Actor, taskId: string, input: ExitInput, clock = () => new Date()) {
  if (actor.role !== 'RIDER' || !actor.riderId) throw forbidden();
  if (!Value.Check(PreparationExitBody, input)) throw badRequest('INVALID_EXIT_REQUEST', 'Invalid exit request fields');
  return prisma.$transaction(async (tx) => {
    const identity = await tx.deliveryTask.findUnique({ where: { id: taskId }, select: { orderId: true } });
    if (!identity) throw notFound('Task');
    await tx.$queryRaw`SELECT "id" FROM "Rider" WHERE "id"=${actor.riderId}::uuid FOR UPDATE`;
    const order = await lockPreparationOrder(tx, identity.orderId);
    const task = order.deliveryTask!;
    const assignment = task.assignments.find((a) => a.id === input.assignmentId && a.riderId === actor.riderId && a.rider.userId === actor.id);
    if (task.riderId !== actor.riderId) throw forbidden();
    if (!assignment || order.status !== 'CLAIMED' || task.status !== 'CLAIMED' || task.pickedUpAt || order.preparationControlState === 'NORMAL') throw conflict('EXIT_NOT_AVAILABLE', 'A current pre-pickup preparation exception is required');
    const signature = JSON.stringify({ action: 'REQUEST_NOFAULT_EXIT', assignmentId: input.assignmentId, expectedVersion: input.expectedVersion, reason: input.reason });
    const prior = await tx.preparationControlAudit.findUnique({ where: { orderId_requestKey: { orderId: order.id, requestKey: input.requestKey } } });
    if (prior) {
      if (prior.actorId !== actor.id || prior.payloadSignature !== signature || assignment.noFaultExitStatus !== 'PENDING') throw conflict('EXIT_RETRY_CONFLICT', 'Exit request or workflow changed');
      return { ...preparationControlView(order), exitReview: { status: assignment.noFaultExitStatus, personalCapacityTemporarilyReleased: assignment.temporaryPersonalCapacityRelease } };
    }
    if (order.preparationControlVersion !== input.expectedVersion || assignment.noFaultExitStatus === 'PENDING') throw conflict('EXIT_VERSION_CONFLICT', 'Refresh the exit workflow');
    const now = clock();
    const linked = await ensurePreparationCase(tx, order);
    await tx.$queryRaw`SELECT "id" FROM "ExceptionCase" WHERE "id"=${linked.id}::uuid FOR UPDATE`;
    const currentCase = await tx.exceptionCase.findUniqueOrThrow({ where: { id: linked.id } });
    if (['RESOLVED', 'CLOSED', 'ESCALATED'].includes(currentCase.status)) throw conflict('EXIT_CASE_STATE_CONFLICT', 'The current case cannot accept an ordinary exit request');
    await tx.deliveryAssignment.update({ where: { id: assignment.id }, data: { noFaultExitStatus: 'PENDING', temporaryPersonalCapacityRelease: true } });
    const updated = await tx.order.update({ where: { id: order.id }, data: { preparationControlState: 'MANUAL_REVIEW', preparationControlVersion: { increment: 1 }, preparationControlUpdatedAt: now } });
    await tx.exceptionCase.update({ where: { id: currentCase.id }, data: { version: { increment: 1 }, lastActionAt: now } });
    await tx.exceptionCaseAction.create({ data: { caseId: currentCase.id, type: 'NOFAULT_EXIT_REQUESTED', actorId: actor.id, reason: input.reason,
      metadata: { assignmentId: assignment.id, personalCapacityTemporarilyReleased: true, globalCapacityReleased: false, formalAssignmentReleased: false } } });
    await tx.preparationControlAudit.create({ data: { orderId: order.id, version: updated.preparationControlVersion, action: 'REQUEST_NOFAULT_EXIT', previousState: order.preparationControlState,
      newState: 'MANUAL_REVIEW', actorId: actor.id, requestKey: input.requestKey, payloadSignature: signature, createdAt: now } });
    return { ...preparationControlView(updated), exitReview: { status: 'PENDING', personalCapacityTemporarilyReleased: true } };
  });
}

export async function reviewPreparationExit(prisma: PrismaClient, actor: Actor, orderId: string, input: ExitReviewInput, clock = () => new Date()) {
  requireAdminLevel(actor, ['OPERATOR', 'SUPER_ADMIN']);
  if (!Value.Check(PreparationExitReviewBody, input)) throw badRequest('INVALID_EXIT_REVIEW', 'Invalid exit review fields');
  return prisma.$transaction(async (tx) => {
    const identity = await tx.deliveryAssignment.findUnique({ where: { id: input.assignmentId }, select: { riderId: true, orderId: true } });
    if (!identity || identity.orderId !== orderId) throw notFound('Assignment');
    await tx.$queryRaw`SELECT "id" FROM "Rider" WHERE "id"=${identity.riderId}::uuid FOR UPDATE`;
    const order = await lockPreparationOrder(tx, orderId);
    const linked = await ensurePreparationCase(tx, order);
    await tx.$queryRaw`SELECT "id" FROM "ExceptionCase" WHERE "id"=${linked.id}::uuid FOR UPDATE`;
    const currentCase = await tx.exceptionCase.findUniqueOrThrow({ where: { id: linked.id } });
    if (currentCase.currentHandlerAdminId !== actor.id) throw forbidden();
    assertExceptionCaseAction(currentCase.status, 'RESOLVE');
    const assignment = await tx.deliveryAssignment.findUniqueOrThrow({ where: { id: input.assignmentId } });
    const signature = JSON.stringify({ action: 'REVIEW_NOFAULT_EXIT', assignmentId: input.assignmentId, expectedVersion: input.expectedVersion, expectedCaseVersion: input.expectedCaseVersion, approve: input.approve, reason: input.reason });
    const prior = await tx.preparationControlAudit.findUnique({ where: { orderId_requestKey: { orderId, requestKey: input.requestKey } } });
    if (prior) {
      if (prior.actorId !== actor.id || prior.payloadSignature !== signature || order.preparationControlVersion !== prior.version
        || currentCase.version !== input.expectedCaseVersion + 1 || assignment.noFaultExitStatus !== (input.approve ? 'APPROVED' : 'REJECTED')
        || !['CLAIMED', 'READY_FOR_RIDER'].includes(order.status) || order.deliveryTask?.pickedUpAt) throw conflict('EXIT_RETRY_WORKFLOW_CHANGED', 'Exit review or workflow changed');
      return { ...preparationControlView(order), exitReview: { status: assignment.noFaultExitStatus, personalCapacityTemporarilyReleased: false } };
    }
    if (currentCase.version !== input.expectedCaseVersion || order.preparationControlVersion !== input.expectedVersion || assignment.status !== 'ACTIVE'
      || assignment.noFaultExitStatus !== 'PENDING' || order.status !== 'CLAIMED' || order.deliveryTask?.status !== 'CLAIMED'
      || order.deliveryTask.riderId !== assignment.riderId || order.deliveryTask.pickedUpAt) throw conflict('EXIT_REVIEW_STATE_CONFLICT', 'Case, assignment or preparation workflow changed');
    const now = clock();
    const status = input.approve ? 'APPROVED' : 'REJECTED';
    if (input.approve && await tx.exceptionCase.count({ where: { orderId, id: { not: currentCase.id }, status: { notIn: ['RESOLVED', 'CLOSED'] } } })) {
      throw conflict('OTHER_EXIT_CONFLICT_UNRESOLVED', 'Other current conflicts must be reviewed before formal assignment release');
    }
    await tx.deliveryAssignment.update({ where: { id: assignment.id }, data: { noFaultExitStatus: status, temporaryPersonalCapacityRelease: false,
      ...(input.approve ? { status: 'ABANDONED', endedAt: now, reason: 'AUDITED_PREPARATION_NOFAULT_EXIT' } : {}) } });
    if (input.approve) {
      await tx.deliveryTask.update({ where: { id: order.deliveryTask.id }, data: { status: 'OPEN', riderId: null, claimedAt: null } });
      await transitionOrder(tx, orderId, 'CLAIMED', 'READY_FOR_RIDER', actor, { eventType: 'RIDER_ABANDONED', reason: input.reason,
        metadata: { action: 'AUDITED_PREPARATION_NOFAULT_EXIT', assignmentId: assignment.id, originalDeadlinePreserved: true, ordinaryCancellationCounted: false } });
    }
    const updated = await tx.order.update({ where: { id: orderId }, data: { preparationControlState: 'MANUAL_REVIEW', preparationControlVersion: { increment: 1 }, preparationControlUpdatedAt: now } });
    const changed = await tx.exceptionCase.updateMany({ where: { id: currentCase.id, version: input.expectedCaseVersion, currentHandlerAdminId: actor.id, status: currentCase.status }, data: { version: { increment: 1 }, lastActionAt: now } });
    if (changed.count !== 1) throw conflict('CASE_VERSION_CONFLICT', 'Handler or case changed');
    await tx.exceptionCaseAction.create({ data: { caseId: currentCase.id, type: 'NOFAULT_EXIT_REVIEWED', actorId: actor.id, reason: input.reason,
      metadata: { assignmentId: assignment.id, outcome: status, formalAssignmentReleased: input.approve, orderTerminated: false, moneyChanged: false } } });
    await tx.preparationControlAudit.create({ data: { orderId, version: updated.preparationControlVersion, action: 'REVIEW_NOFAULT_EXIT', previousState: order.preparationControlState,
      newState: 'MANUAL_REVIEW', actorId: actor.id, requestKey: input.requestKey, payloadSignature: signature, createdAt: now } });
    return { ...preparationControlView(updated), exitReview: { status, personalCapacityTemporarilyReleased: false } };
  });
}
