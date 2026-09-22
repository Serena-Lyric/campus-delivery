import {
  EvidenceType,
  OrderStatus,
  PickupVerificationMode,
  DeliveryVerificationMode,
  VerificationPurpose,
  type Order,
  type Prisma,
  type PrismaClient,
} from '@prisma/client';
import { randomBytes, randomInt, scryptSync, timingSafeEqual } from 'node:crypto';
import type { Actor } from '../auth/auth.js';
import { loadPolicyConfig } from '../merchant-policy/policies.js';
import { conflict, forbidden, notFound } from '../shared/errors.js';

function hashCode(code: string, salt: string): Buffer {
  return scryptSync(code, salt, 32);
}

export async function issueVerificationCode(
  prisma: PrismaClient,
  actor: Actor,
  orderId: string,
  purpose: VerificationPurpose,
  now = new Date(),
) {
  const order = await prisma.order.findUnique({ where: { id: orderId } });
  if (!order) throw notFound('Order');

  if (purpose === VerificationPurpose.DELIVERY) {
    if (actor.role !== 'CUSTOMER' || order.customerId !== actor.id) throw forbidden();
    if (order.deliveryVerificationMode !== DeliveryVerificationMode.HANDOFF_CODE) {
      throw conflict('VERIFICATION_NOT_REQUIRED', 'This order does not require a delivery handoff code');
    }
  } else {
    if (actor.role !== 'MERCHANT' || order.merchantId !== actor.merchantId) throw forbidden();
    if (order.pickupVerificationMode !== PickupVerificationMode.PICKUP_CODE) {
      throw conflict('VERIFICATION_NOT_REQUIRED', 'This order does not require a pickup code');
    }
  }

  const { config } = await loadPolicyConfig(prisma);
  const code = randomInt(0, 1_000_000).toString().padStart(6, '0');
  const salt = randomBytes(16).toString('hex');
  const codeHash = hashCode(code, salt).toString('hex');
  const expiresAt = new Date(now.getTime() + config.verificationCodeTtlSeconds * 1000);

  const record = await prisma.$transaction(async (tx) => {
    await tx.verificationCode.updateMany({
      where: { orderId, purpose, verifiedAt: null, invalidatedAt: null },
      data: { invalidatedAt: now },
    });
    return tx.verificationCode.create({
      data: { orderId, purpose, salt, codeHash, issuerId: actor.id, expiresAt },
    });
  });

  return { id: record.id, purpose, code, expiresAt };
}

export async function verifyOrderCode(
  tx: Prisma.TransactionClient,
  order: Pick<Order, 'id' | 'status'>,
  purpose: VerificationPurpose,
  actor: Actor,
  code: string,
  now = new Date(),
) {
  const record = await tx.verificationCode.findFirst({
    where: {
      orderId: order.id,
      purpose,
      verifiedAt: null,
      invalidatedAt: null,
      expiresAt: { gt: now },
    },
    orderBy: { createdAt: 'desc' },
  });
  if (!record) throw conflict('VERIFICATION_CODE_UNAVAILABLE', 'No active verification code is available');

  const supplied = hashCode(code, record.salt);
  const expected = Buffer.from(record.codeHash, 'hex');
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
    throw conflict('INVALID_VERIFICATION_CODE', 'Verification code is incorrect');
  }

  const updated = await tx.verificationCode.updateMany({
    where: { id: record.id, verifiedAt: null, invalidatedAt: null, expiresAt: { gt: now } },
    data: { verifiedAt: now, verifierId: actor.id },
  });
  if (updated.count !== 1) throw conflict('VERIFICATION_CODE_USED', 'Verification code is no longer active');

  return tx.evidence.create({
    data: {
      orderId: order.id,
      actorId: actor.id,
      actorRole: actor.role,
      evidenceType: purpose === VerificationPurpose.DELIVERY
        ? EvidenceType.HANDOFF_CODE_VERIFICATION
        : EvidenceType.PICKUP_CODE_VERIFICATION,
      orderStage: order.status,
      metadata: { verificationCodeId: record.id },
    },
  });
}

export async function verifyPickupCode(
  prisma: PrismaClient,
  actor: Actor,
  taskId: string,
  code: string,
  now = new Date(),
) {
  if (!actor.riderId) throw forbidden();
  return prisma.$transaction(async (tx) => {
    const task = await tx.deliveryTask.findUnique({ where: { id: taskId }, include: { order: true } });
    if (!task) throw notFound('Delivery task');
    if (task.riderId !== actor.riderId) throw forbidden();
    if (task.order.status !== OrderStatus.CLAIMED) {
      throw conflict('ORDER_STATE_CONFLICT', 'Order is not ready for pickup verification');
    }
    const evidence = await verifyOrderCode(tx, task.order, VerificationPurpose.PICKUP, actor, code, now);
    return { verified: true, evidenceId: evidence.id };
  });
}
