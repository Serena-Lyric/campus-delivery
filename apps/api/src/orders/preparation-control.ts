import type { Order, PreparationControlState, Prisma, PrismaClient } from '@prisma/client';
import { Type } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import type { Actor } from '../auth/auth.js';
import { badRequest, conflict, forbidden, notFound } from '../shared/errors.js';
import { openExceptionCase } from '../exception-cases/service.js';
import { assertOrderAccess } from './access.js';

export const preparationUuid = () => Type.String({ pattern: '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' });
const base = { expectedVersion: Type.Integer({ minimum: 0, maximum: 2147483646 }), requestKey: preparationUuid() };
const reason = Type.String({ minLength: 1, maxLength: 500, pattern: '\\S' });
export const preparationActionSchemas = {
  DECLARE_UNABLE: Type.Object({ ...base, reason }, { additionalProperties: false }),
  REQUEST_RECOVERY: Type.Object({ ...base }, { additionalProperties: false }),
  REPORT_UNABLE: Type.Object({ ...base, assignmentId: preparationUuid(), reason }, { additionalProperties: false }),
  RESPOND_RECOVERY: Type.Object({ ...base, assignmentId: preparationUuid(), accept: Type.Boolean() }, { additionalProperties: false }),
  ESCALATE: Type.Object({ ...base, reason }, { additionalProperties: false }),
};
export type PreparationAction = keyof typeof preparationActionSchemas;
export type PreparationActionInput = { expectedVersion: number; requestKey: string; reason?: string; assignmentId?: string; accept?: boolean };
const labels = { NORMAL: '可继续履约', UNABLE: '商家声明无法出餐，暂停新承接', RECOVERY_PENDING: '恢复提议，等待当前骑手确认', MANUAL_REVIEW: '暂停正常流程，等待人工处理' };
export function preparationControlView(order: Pick<Order, 'preparationControlState' | 'preparationControlVersion' | 'preparationControlReason' | 'preparationControlUpdatedAt'>) {
  return { state: order.preparationControlState, version: order.preparationControlVersion, reason: order.preparationControlReason,
    updatedAt: order.preparationControlUpdatedAt, claimPaused: order.preparationControlState !== 'NORMAL',
    requiresRiderResponse: order.preparationControlState === 'RECOVERY_PENDING', statusLabel: labels[order.preparationControlState],
    automaticEscalationEnabled: false, recoveryTimeoutSeconds: null };
}
export const PreparationControlView = Type.Object({ state: Type.Union(Object.keys(labels).map((state) => Type.Literal(state))), version: Type.Integer(),
  reason: Type.Union([Type.String(), Type.Null()]), updatedAt: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
  claimPaused: Type.Boolean(), requiresRiderResponse: Type.Boolean(), statusLabel: Type.String(),
  automaticEscalationEnabled: Type.Literal(false), recoveryTimeoutSeconds: Type.Null() }, { additionalProperties: false });

export async function lockPreparationOrder(tx: Prisma.TransactionClient, orderId: string) {
  await tx.$queryRaw`SELECT "id" FROM "Order" WHERE "id"=${orderId}::uuid FOR UPDATE`;
  const identity = await tx.deliveryTask.findUnique({ where: { orderId }, select: { id: true } });
  if (identity) await tx.$queryRaw`SELECT "id" FROM "DeliveryTask" WHERE "id"=${identity.id}::uuid FOR UPDATE`;
  const order = await tx.order.findUnique({ where: { id: orderId }, include: { merchant: { select: { ownerId: true } },
    deliveryTask: { include: { assignments: { where: { status: 'ACTIVE' }, include: { rider: { select: { userId: true } } } } } } } });
  if (!order) throw notFound('Order');
  return order;
}
export async function ensurePreparationCase(tx: Prisma.TransactionClient, order: Pick<Order, 'preparationSourceExceptionId'>) {
  if (!order.preparationSourceExceptionId) throw conflict('PREPARATION_SOURCE_MISSING', 'A recorded participant statement is required for manual review');
  const previous = await tx.exceptionCase.findUnique({ where: { exceptionEventId: order.preparationSourceExceptionId } });
  if (previous) return previous;
  const source = await tx.exceptionEvent.findUniqueOrThrow({ where: { id: order.preparationSourceExceptionId } });
  return openExceptionCase(tx, source);
}
export async function expirePausedPreparation(tx: Prisma.TransactionClient, task: { riderId: string | null; claimDeadline: Date | null; order: Order }, now: Date) {
  const order = task.order;
  if (order.preparationControlState === 'NORMAL' || task.riderId || !task.claimDeadline || task.claimDeadline > now || order.status !== 'READY_FOR_RIDER') return false;
  await ensurePreparationCase(tx, order);
  if (order.preparationControlState === 'MANUAL_REVIEW') return true;
  await tx.order.update({ where: { id: order.id }, data: { preparationControlState: 'MANUAL_REVIEW', preparationControlVersion: { increment: 1 }, preparationControlUpdatedAt: now } });
  await tx.preparationControlAudit.create({ data: { orderId: order.id, version: order.preparationControlVersion + 1, action: 'PAUSED_DEADLINE_REVIEW',
    previousState: order.preparationControlState, newState: 'MANUAL_REVIEW', payloadSignature: 'ORIGINAL_CLAIM_DEADLINE_PASSED', createdAt: now } });
  await tx.orderEvent.create({ data: { orderId: order.id, eventType: 'EXCEPTION_RECORDED', actorType: 'SYSTEM', fromStatus: order.status, toStatus: order.status,
    metadata: { action: 'PAUSED_DEADLINE_REVIEW', naturalNoRiderFailure: false, fundsChanged: false }, createdAt: now } });
  return true;
}

export async function applyPreparationAction(prisma: PrismaClient, actor: Actor, orderId: string, action: PreparationAction, input: PreparationActionInput, clock = () => new Date()) {
  if (!Value.Check(preparationActionSchemas[action], input)) throw badRequest('INVALID_PREPARATION_ACTION', 'Invalid preparation action fields');
  return prisma.$transaction(async (tx) => {
    const order = await lockPreparationOrder(tx, orderId);
    const assignment = order.deliveryTask?.assignments.find((a) => a.id === input.assignmentId && a.riderId === actor.riderId && a.rider.userId === actor.id);
    const isCurrentRider = Boolean(actor.role === 'RIDER' && actor.riderId && order.deliveryTask?.riderId === actor.riderId
      && order.deliveryTask?.assignments.some((a) => a.riderId === actor.riderId && a.rider.userId === actor.id));
    const isOwner = actor.role === 'MERCHANT' && actor.merchantId === order.merchantId && actor.id === order.merchant.ownerId;
    if (['DECLARE_UNABLE', 'REQUEST_RECOVERY'].includes(action) && !isOwner) throw forbidden();
    if (['REPORT_UNABLE', 'RESPOND_RECOVERY'].includes(action)) {
      if (!isCurrentRider) throw forbidden();
      if (!assignment) throw conflict('PREPARATION_ASSIGNMENT_CHANGED', 'Refresh the active assignment');
    }
    if (action === 'ESCALATE' && !isOwner && !isCurrentRider && !(actor.role === 'CUSTOMER' && actor.id === order.customerId)) throw forbidden();
    if (!['CREATED', 'MERCHANT_PENDING', 'MERCHANT_CONFIRMED', 'READY_FOR_RIDER', 'CLAIMED'].includes(order.status) || order.deliveryTask?.pickedUpAt) throw conflict('PREPARATION_STATE_CONFLICT', 'Preparation actions are only available before handoff or termination');
    const signature = JSON.stringify({ action, expectedVersion: input.expectedVersion, reason: input.reason ?? null, assignmentId: input.assignmentId ?? null, accept: input.accept ?? null });
    const prior = await tx.preparationControlAudit.findUnique({ where: { orderId_requestKey: { orderId, requestKey: input.requestKey } } });
    if (prior) {
      if (prior.actorId !== actor.id || prior.payloadSignature !== signature) throw conflict('PREPARATION_RETRY_CONFLICT', 'Request key was already used for another action');
      return preparationControlView(order);
    }
    if (order.preparationControlVersion !== input.expectedVersion) throw conflict('PREPARATION_VERSION_CONFLICT', 'Refresh the preparation workflow version');
    const now = clock();
    let sourceCase = order.preparationSourceExceptionId
      ? await tx.exceptionCase.findUnique({ where: { exceptionEventId: order.preparationSourceExceptionId } }) : null;
    if (sourceCase) {
      await tx.$queryRaw`SELECT "id" FROM "ExceptionCase" WHERE "id"=${sourceCase.id}::uuid FOR UPDATE`;
      sourceCase = await tx.exceptionCase.findUniqueOrThrow({ where: { id: sourceCase.id } });
    }
    if (['REQUEST_RECOVERY', 'RESPOND_RECOVERY'].includes(action) && sourceCase?.status === 'ESCALATED') {
      throw conflict('PREPARATION_CASE_ESCALATED', 'A lawful audited takeover is required before ordinary recovery');
    }
    let state: PreparationControlState = order.preparationControlState;
    let sourceId = order.preparationSourceExceptionId;
    let reportedAssignmentId = order.preparationReportedAssignmentId;
    if (action === 'DECLARE_UNABLE' || action === 'REPORT_UNABLE') {
      const event = await tx.exceptionEvent.create({ data: { orderId, reporterId: actor.id, reporterRole: actor.role, orderStatus: order.status,
        type: 'MERCHANT_PREPARATION_UNAVAILABLE', description: input.reason!, createdAt: now } });
      if (state === 'NORMAL' || !sourceId || (sourceCase && (sourceCase.category !== 'MERCHANT_PREPARATION_UNAVAILABLE' || ['RESOLVED', 'CLOSED'].includes(sourceCase.status)))) sourceId = event.id;
      state = state === 'MANUAL_REVIEW' ? 'MANUAL_REVIEW' : 'UNABLE';
      if (action === 'REPORT_UNABLE') reportedAssignmentId = assignment!.id;
    } else if (action === 'REQUEST_RECOVERY') {
      if (state === 'NORMAL') throw conflict('PREPARATION_NOT_PAUSED', 'There is no pause to recover');
      const otherConflicts = await tx.exceptionCase.count({ where: { orderId, status: { notIn: ['RESOLVED', 'CLOSED'] }, ...(sourceId ? { exceptionEventId: { not: sourceId } } : {}) } });
      if (state === 'MANUAL_REVIEW' || otherConflicts || (reportedAssignmentId && !order.deliveryTask?.assignments.some((a) => a.id === reportedAssignmentId && a.riderId === order.deliveryTask?.riderId))) state = 'MANUAL_REVIEW';
      else if (reportedAssignmentId) state = 'RECOVERY_PENDING';
      else if (!order.deliveryTask?.riderId && order.deliveryTask?.claimDeadline && now >= order.deliveryTask.claimDeadline) state = 'MANUAL_REVIEW';
      else state = 'NORMAL';
    } else if (action === 'RESPOND_RECOVERY') {
      if (state !== 'RECOVERY_PENDING' || assignment!.id !== reportedAssignmentId) throw conflict('RECOVERY_NOT_PENDING', 'This assignment has no pending recovery request');
      if (input.accept && await tx.exceptionCase.count({ where: { orderId, status: { notIn: ['RESOLVED', 'CLOSED'] }, ...(sourceId ? { exceptionEventId: { not: sourceId } } : {}) } })) {
        throw conflict('RECOVERY_OTHER_CASE_PENDING', 'Another unresolved case requires authorized human review before recovery');
      }
      state = input.accept ? 'NORMAL' : 'MANUAL_REVIEW';
      if (input.accept) reportedAssignmentId = null;
    } else {
      if (state === 'NORMAL') throw conflict('PREPARATION_NOT_PAUSED', 'There is no preparation conflict to escalate');
      if (sourceCase && ['RESOLVED', 'CLOSED'].includes(sourceCase.status)) {
        const event = await tx.exceptionEvent.create({ data: { orderId, reporterId: actor.id, reporterRole: actor.role, orderStatus: order.status,
          type: 'MERCHANT_PREPARATION_UNAVAILABLE', description: input.reason!, createdAt: now } });
        sourceId = event.id;
      }
      state = 'MANUAL_REVIEW';
    }
    const changed = await tx.order.updateMany({ where: { id: orderId, status: order.status, preparationControlVersion: input.expectedVersion }, data: {
      preparationControlState: state, preparationControlVersion: { increment: 1 }, preparationControlUpdatedAt: now,
      ...(input.reason ? { preparationControlReason: input.reason } : {}), preparationSourceExceptionId: sourceId, preparationReportedAssignmentId: reportedAssignmentId,
    } });
    if (changed.count !== 1) throw conflict('PREPARATION_VERSION_CONFLICT', 'Workflow changed concurrently');
    const updated = await tx.order.findUniqueOrThrow({ where: { id: orderId } });
    if (state === 'MANUAL_REVIEW' || action === 'REPORT_UNABLE') await ensurePreparationCase(tx, updated);
    await tx.preparationControlAudit.create({ data: { orderId, version: input.expectedVersion + 1, action, previousState: order.preparationControlState,
      newState: state, actorId: actor.id, requestKey: input.requestKey, payloadSignature: signature, createdAt: now } });
    await tx.orderEvent.create({ data: { orderId, eventType: 'MERCHANT_PREPARATION_UPDATED', actorType: 'USER', fromStatus: order.status, toStatus: order.status,
      operatorId: actor.id, operatorRole: actor.role, createdAt: now, metadata: { action, state, preparationVersion: input.expectedVersion + 1, selfReported: true, fundsChanged: false } } });
    return preparationControlView(updated);
  });
}

export async function getPreparationControl(prisma: PrismaClient, actor: Actor, orderId: string, clock = () => new Date()) {
  return prisma.$transaction(async (tx) => {
    const order = await lockPreparationOrder(tx, orderId);
    assertOrderAccess(actor, order);
    if (actor.role === 'RIDER' && !order.deliveryTask?.assignments.some((a) => a.riderId === actor.riderId && order.deliveryTask?.riderId === actor.riderId)) throw forbidden();
    if (actor.role === 'MERCHANT' && order.merchant.ownerId !== actor.id) throw forbidden();
    if (order.deliveryTask && await expirePausedPreparation(tx, { ...order.deliveryTask, order }, clock())) {
      return preparationControlView(await tx.order.findUniqueOrThrow({ where: { id: orderId } }));
    }
    return preparationControlView(order);
  });
}
