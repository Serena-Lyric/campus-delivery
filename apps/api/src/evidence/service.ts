import {
  EvidenceType,
  OrderStatus,
  type Prisma,
  type PrismaClient,
} from '@prisma/client';
import type { Actor } from '../auth/auth.js';
import { badRequest, forbidden, notFound } from '../shared/errors.js';
import type { MediaInput, MediaStorage } from './media-storage.js';

const manualPhotoTypes = new Set<EvidenceType>([
  EvidenceType.MERCHANT_HANDOFF_PHOTO,
  EvidenceType.RIDER_PICKUP_PHOTO,
  EvidenceType.DELIVERY_PHOTO,
]);

export type CreateEvidenceInput = {
  evidenceType: EvidenceType;
  media: MediaInput;
  note?: string;
  metadata?: Record<string, unknown>;
};

export async function createEvidence(
  prisma: PrismaClient,
  storage: MediaStorage,
  actor: Actor,
  orderId: string,
  input: CreateEvidenceInput,
) {
  if (!manualPhotoTypes.has(input.evidenceType)) {
    throw badRequest('SYSTEM_EVIDENCE_ONLY', 'Code verification evidence can only be created by verification services');
  }

  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: { deliveryTask: true },
  });
  if (!order) throw notFound('Order');

  const merchantAllowed = actor.role === 'MERCHANT'
    && order.merchantId === actor.merchantId
    && input.evidenceType === EvidenceType.MERCHANT_HANDOFF_PHOTO
    && (order.status === OrderStatus.MERCHANT_CONFIRMED
      || order.status === OrderStatus.READY_FOR_RIDER);
  const riderAllowed = actor.role === 'RIDER'
    && order.deliveryTask?.riderId === actor.riderId
    && (
      (input.evidenceType === EvidenceType.RIDER_PICKUP_PHOTO && order.status === OrderStatus.CLAIMED)
      || (input.evidenceType === EvidenceType.DELIVERY_PHOTO && order.status === OrderStatus.PICKED_UP)
    );
  const adminAllowed = actor.role === 'ADMIN' && actor.adminLevel === 'SUPER_ADMIN';
  if (!merchantAllowed && !riderAllowed && !adminAllowed) throw forbidden();

  const mediaReference = await storage.createReference(order.id, input.media);
  const metadata: Prisma.InputJsonObject = {
    ...(input.metadata ?? {}),
    contentType: input.media.contentType,
    source: input.media.source ?? 'UNKNOWN',
    ...(input.media.capturedAt ? { capturedAt: input.media.capturedAt } : {}),
    authenticityVerified: false,
  };

  return prisma.evidence.create({
    data: {
      orderId: order.id,
      actorId: actor.id,
      actorRole: actor.role,
      evidenceType: input.evidenceType,
      orderStage: order.status,
      mediaReference,
      ...(input.note ? { note: input.note } : {}),
      metadata,
    },
  });
}
