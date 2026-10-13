import type { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import type { Actor } from '../auth/auth.js';
import { conflict, forbidden } from '../shared/errors.js';
import { transitionOrder } from '../orders/state-machine.js';
import { assertNoPickupDispute } from './custody-guard.js';
import { checkMerchantPickupCode, lockPickupOrder } from './pickup-code.js';

export type MerchantPickupInput = { assignmentId: string; expectedRevision: number; requestKey: string; photoEvidenceId?: string; codeId?: string; code?: string };

export async function confirmRiderPickup(prisma: PrismaClient, actor: Actor, orderId: string, input: MerchantPickupInput, now = new Date()) {
  if (actor.role !== 'MERCHANT' || !actor.merchantId) throw forbidden();
  const result = await prisma.$transaction(async (tx) => {
    const task = await lockPickupOrder(tx, orderId);
    if (task.order.merchantId !== actor.merchantId) throw forbidden();
    if (task.order.preparationControlState !== 'NORMAL') throw conflict('PREPARATION_PICKUP_PAUSED', 'Recovery or manual preparation review must complete before handoff');
    if (task.order.goodsChangeReviewPending) throw conflict('GOODS_CHANGE_PICKUP_PAUSED', 'Added or unassessed goods risk requires authorized human review before handoff');
    const assignment = task.assignments.find((a) => a.id === input.assignmentId && a.riderId === task.riderId);
    if (!assignment || task.order.pickupHandoffRevision !== input.expectedRevision) throw conflict('PICKUP_ASSIGNMENT_CHANGED', 'Current assignment or pickup revision differs');
    await assertNoPickupDispute(tx, orderId);
    const previous = await tx.pickupHandoff.findUnique({ where: { orderId_requestKey: { orderId, requestKey: input.requestKey } } });
    if (previous && task.status === 'PICKED_UP' && task.order.status === 'PICKED_UP') {
      if (previous.assignmentId !== input.assignmentId || previous.revision !== input.expectedRevision || previous.photoEvidenceId !== (input.photoEvidenceId ?? null) || (input.codeId !== undefined && previous.verificationCodeId !== input.codeId)) throw conflict('PICKUP_IDEMPOTENCY_CONFLICT', 'Retry differs from the original handoff');
      return { handoffId: previous.id, eventId: previous.eventId, assignmentId: assignment.id, revision: previous.revision, status: 'PICKED_UP', physicalHandoffProven: false };
    }
    if (previous || task.status !== 'CLAIMED' || task.order.status !== 'CLAIMED' || task.pickedUpAt) throw conflict('PICKUP_STATE_CONFLICT', 'Order is not awaiting this pickup attempt');
    // The claim deadline governs new claims only. A valid active claim may pick up later.
    if (task.order.pickupVerificationMode === 'PHOTO' || task.order.pickupEvidenceLevel === 'REQUIRED') {
      const photo = input.photoEvidenceId ? await tx.evidence.findFirst({ where: { id: input.photoEvidenceId, orderId, actorId: assignment.rider.userId, actorRole: 'RIDER', evidenceType: 'RIDER_PICKUP_PHOTO', orderStage: 'CLAIMED', createdAt: { gte: assignment.claimedAt } } }) : null;
      const metadata = photo?.metadata as { contentType?: unknown; pickupHandoffRevision?: unknown; assignmentId?: unknown } | null;
      if (!photo || !photo.mediaReference?.startsWith(`mock://evidence/${orderId}/`) || !['image/jpeg', 'image/png', 'image/webp'].includes(String(metadata?.contentType)) || metadata?.pickupHandoffRevision !== input.expectedRevision || metadata?.assignmentId !== assignment.id) throw conflict('INVALID_PICKUP_PHOTO', 'A stored image from the current rider and pickup attempt is required');
    } else if (input.photoEvidenceId) {
      const photo = await tx.evidence.findFirst({ where: { id: input.photoEvidenceId, orderId, actorId: assignment.rider.userId, actorRole: 'RIDER', evidenceType: 'RIDER_PICKUP_PHOTO', orderStage: 'CLAIMED', createdAt: { gte: assignment.claimedAt } } });
      if (!photo) throw conflict('INVALID_PICKUP_PHOTO', 'Optional photo must belong to this rider and claim');
    }
    let verificationCodeId: string | null = null;
    if (task.order.pickupVerificationMode === 'PICKUP_CODE') {
      const verified = await checkMerchantPickupCode(tx, { orderId, assignmentId: assignment.id, revision: input.expectedRevision, riderUserId: assignment.rider.userId, merchantActorId: actor.id, ...(input.codeId ? { codeId: input.codeId } : {}), ...(input.code ? { code: input.code } : {}) }, now);
      if ('error' in verified) return { error: verified.error };
      verificationCodeId = verified.codeId;
    } else if (input.codeId || input.code) throw conflict('PICKUP_CODE_NOT_REQUIRED', 'This order does not use code verification');
    const handoffId = randomUUID();
    const eventId = await transitionOrder(tx, orderId, 'CLAIMED', 'PICKED_UP', actor, { eventType: 'PICKED_UP', metadata: { protocolVersion: 1, handoffId, assignmentId: assignment.id, riderId: assignment.riderId, revision: input.expectedRevision, verificationMode: task.order.pickupVerificationMode, pickupEvidenceLevel: task.order.pickupEvidenceLevel, photoEvidenceId: input.photoEvidenceId ?? null, verificationCodeId, physicalHandoffProven: false } });
    await tx.pickupHandoff.create({ data: { id: handoffId, orderId, assignmentId: assignment.id, revision: input.expectedRevision, requestKey: input.requestKey, merchantActorId: actor.id, eventId, photoEvidenceId: input.photoEvidenceId ?? null, verificationCodeId, createdAt: now } });
    await tx.deliveryTask.update({ where: { id: task.id }, data: { status: 'PICKED_UP', pickedUpAt: now } });
    return { handoffId, eventId, assignmentId: assignment.id, revision: input.expectedRevision, status: 'PICKED_UP', physicalHandoffProven: false };
  });
  if ('error' in result && result.error) throw result.error;
  return result;
}
