import {
  EvidenceType,
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
  if (purpose === VerificationPurpose.PICKUP) throw conflict('RIDER_PICKUP_CODE_REQUIRED', 'Legacy merchant-issued pickup codes are retired; the current rider must request a bound code');
  const order = await prisma.order.findUnique({ where: { id: orderId } });
  if (!order) throw notFound('Order');

  if (purpose === VerificationPurpose.DELIVERY) {
    if (actor.role !== 'CUSTOMER' || order.customerId !== actor.id) throw forbidden();
    if (order.deliveryVerificationMode !== DeliveryVerificationMode.HANDOFF_CODE) {
      throw conflict('VERIFICATION_NOT_REQUIRED', 'This order does not require a delivery handoff code');
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
  if (purpose === VerificationPurpose.PICKUP) throw conflict('MERCHANT_PICKUP_CONFIRMATION_REQUIRED', 'Use the assignment-bound merchant pickup verifier');
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
      evidenceType: EvidenceType.HANDOFF_CODE_VERIFICATION,
      orderStage: order.status,
      metadata: { verificationCodeId: record.id },
    },
  });
}

export async function verifyPickupCode(_prisma: PrismaClient, actor: Actor, _taskId: string, _code: string, _now = new Date()) {
  if (actor.role !== 'RIDER' || !actor.riderId) throw forbidden();
  throw conflict('MERCHANT_PICKUP_CONFIRMATION_REQUIRED', 'The merchant verifies the rider-issued code during pickup confirmation');
}
