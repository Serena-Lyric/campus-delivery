import type { Prisma, PrismaClient } from '@prisma/client';
import { randomBytes, randomInt, scryptSync, timingSafeEqual } from 'node:crypto';
import type { Actor } from '../auth/auth.js';
import { conflict, forbidden, notFound } from '../shared/errors.js';
import { assertNoPickupDispute } from './custody-guard.js';
import { loadPolicyConfig } from '../merchant-policy/policies.js';

// Engineering defaults, not merchant risk or punishment policy.
export const pickupCodeLimits = { maxAttempts: 5, maxIssues: 5, windowMs: 600_000 };
export const pickupCodeHash = (code: string, salt: string) => scryptSync(code, salt, 32);
export function pickupCodeMatches(code: string, salt: string, hash: string) {
  const expected = Buffer.from(hash, 'hex');
  const supplied = pickupCodeHash(code, salt);
  return expected.length === supplied.length && timingSafeEqual(expected, supplied);
}

export async function lockPickupOrder(tx: Prisma.TransactionClient, orderId: string) {
  await tx.$queryRaw`SELECT "id" FROM "Order" WHERE "id" = ${orderId}::uuid FOR UPDATE`;
  const identity = await tx.deliveryTask.findUnique({ where: { orderId }, select: { id: true } });
  if (!identity) throw notFound('Order task');
  await tx.$queryRaw`SELECT "id" FROM "DeliveryTask" WHERE "id" = ${identity.id}::uuid FOR UPDATE`;
  return tx.deliveryTask.findUniqueOrThrow({ where: { id: identity.id }, include: { order: true, assignments: { where: { status: 'ACTIVE' }, include: { rider: { select: { userId: true } } } } } });
}

export async function issueRiderPickupCode(prisma: PrismaClient, actor: Actor, taskId: string, assignmentId: string, now = new Date()) {
  if (actor.role !== 'RIDER' || !actor.riderId) throw forbidden();
  const { config } = await loadPolicyConfig(prisma);
  return prisma.$transaction(async (tx) => {
    const identity = await tx.deliveryTask.findUnique({ where: { id: taskId }, select: { orderId: true } });
    if (!identity) throw notFound('Delivery task');
    const task = await lockPickupOrder(tx, identity.orderId);
    const assignment = task.assignments.find((a) => a.id === assignmentId && a.riderId === actor.riderId);
    if (!assignment || task.riderId !== actor.riderId) throw forbidden();
    await assertNoPickupDispute(tx, task.orderId);
    if (task.status !== 'CLAIMED' || task.order.status !== 'CLAIMED' || task.order.pickupVerificationMode !== 'PICKUP_CODE') throw conflict('PICKUP_CODE_NOT_AVAILABLE', 'Current claim does not need a pickup code');
    const window = { assignmentId, purpose: 'PICKUP' as const, protocolVersion: 1, createdAt: { gte: new Date(now.getTime() - pickupCodeLimits.windowMs) } };
    const previous = await tx.verificationCode.aggregate({ where: window, _count: true, _sum: { failedAttempts: true } });
    if (previous._count >= pickupCodeLimits.maxIssues || (previous._sum.failedAttempts ?? 0) >= pickupCodeLimits.maxAttempts) throw conflict('PICKUP_CODE_RATE_LIMIT', 'Wait before requesting another pickup code');
    await tx.verificationCode.updateMany({ where: { orderId: task.orderId, purpose: 'PICKUP', verifiedAt: null, invalidatedAt: null }, data: { invalidatedAt: now } });
    const code = randomInt(0, 1_000_000).toString().padStart(6, '0');
    const salt = randomBytes(16).toString('hex');
    const expiresAt = new Date(now.getTime() + Math.min(config.verificationCodeTtlSeconds * 1000, pickupCodeLimits.windowMs));
    const record = await tx.verificationCode.create({ data: { orderId: task.orderId, purpose: 'PICKUP', assignmentId, protocolVersion: 1, handoffRevision: task.order.pickupHandoffRevision, issuerId: actor.id, salt, codeHash: pickupCodeHash(code, salt).toString('hex'), expiresAt, createdAt: now } });
    return { id: record.id, assignmentId, revision: record.handoffRevision, purpose: 'PICKUP', code, expiresAt };
  });
}

// Return an error, rather than throwing, so the caller commits the failed attempt.
export async function checkMerchantPickupCode(tx: Prisma.TransactionClient, input: { orderId: string; assignmentId: string; revision: number; riderUserId: string; merchantActorId: string; codeId?: string; code?: string }, now: Date) {
  const record = input.codeId ? await tx.verificationCode.findUnique({ where: { id: input.codeId } }) : await tx.verificationCode.findFirst({ where: { orderId: input.orderId, assignmentId: input.assignmentId, purpose: 'PICKUP', protocolVersion: 1, handoffRevision: input.revision, verifiedAt: null, invalidatedAt: null, expiresAt: { gt: now } }, orderBy: { createdAt: 'desc' } });
  if (!record || !input.code || record.purpose !== 'PICKUP' || record.orderId !== input.orderId || record.assignmentId !== input.assignmentId || record.protocolVersion !== 1 || record.handoffRevision !== input.revision || record.issuerId !== input.riderUserId || record.verifiedAt || record.invalidatedAt || record.expiresAt <= now) return { error: conflict('PICKUP_CODE_UNAVAILABLE', 'Provide an active code issued to the current rider and pickup attempt') };
  const attempts = await tx.verificationCode.aggregate({ where: { assignmentId: input.assignmentId, protocolVersion: 1, createdAt: { gte: new Date(now.getTime() - pickupCodeLimits.windowMs) } }, _sum: { failedAttempts: true } });
  if ((attempts._sum.failedAttempts ?? 0) >= pickupCodeLimits.maxAttempts) return { error: conflict('PICKUP_CODE_RATE_LIMIT', 'Too many failed pickup code attempts') };
  if (!pickupCodeMatches(input.code, record.salt, record.codeHash)) {
    await tx.verificationCode.update({ where: { id: record.id }, data: { failedAttempts: { increment: 1 } } });
    return { error: conflict('INVALID_PICKUP_CODE', 'Pickup code is incorrect') };
  }
  await tx.verificationCode.update({ where: { id: record.id }, data: { verifiedAt: now, verifierId: input.merchantActorId } });
  await tx.evidence.create({ data: { orderId: input.orderId, actorId: input.merchantActorId, actorRole: 'MERCHANT', evidenceType: 'PICKUP_CODE_VERIFICATION', orderStage: 'CLAIMED', metadata: { protocolVersion: 1, verificationCodeId: record.id, assignmentId: input.assignmentId, revision: input.revision, riderUserId: input.riderUserId, physicalHandoffProven: false } } });
  return { codeId: record.id };
}
