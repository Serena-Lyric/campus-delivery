import {
  RiderCapacityEventType,
  RiderCapacityStage,
  type Prisma,
  type PrismaClient,
} from '@prisma/client';
import { requireAdminLevel, type Actor } from '../auth/auth.js';
import type { AppConfig } from '../config.js';
import { loadPolicyConfig, type PolicyConfig } from '../merchant-policy/policies.js';
import { badRequest, notFound } from '../shared/errors.js';
import { campusDay } from '../shared/time.js';

function stageFor(firstNormalDeliveredAt: Date | null, now: Date, timeZone: string) {
  if (!firstNormalDeliveredAt) return { stage: RiderCapacityStage.TUTORIAL, capacity: 1 };
  if (campusDay(firstNormalDeliveredAt, timeZone).getTime() === campusDay(now, timeZone).getTime()) {
    return { stage: RiderCapacityStage.FIRST_DELIVERY_SAME_DAY, capacity: 2 };
  }
  return { stage: RiderCapacityStage.STANDARD, capacity: 5 };
}

export async function resolveRiderCapacity(
  prisma: PrismaClient | Prisma.TransactionClient,
  riderId: string,
  config: PolicyConfig,
  timeZone: string,
  now: Date,
) {
  const rider = await prisma.rider.findUnique({ where: { id: riderId } });
  if (!rider) throw notFound('Rider');
  const stage = stageFor(rider.firstNormalDeliveredAt, now, timeZone);
  if (stage.stage === RiderCapacityStage.STANDARD && rider.firstNormalDeliveredAt) {
    await prisma.riderCapacityEvent.upsert({
      where: { stageEventKey: `${riderId}:NEXT_DAY_UPGRADE` },
      update: {},
      create: {
        riderId,
        type: RiderCapacityEventType.NEXT_DAY_UPGRADE,
        stage: RiderCapacityStage.STANDARD,
        previousCapacity: 2,
        newCapacity: 5,
        reason: 'NEXT_CAMPUS_DAY_AFTER_FIRST_DELIVERY',
        stageEventKey: `${riderId}:NEXT_DAY_UPGRADE`,
        metadata: { firstNormalDeliveredAt: rider.firstNormalDeliveredAt.toISOString(), timeZone },
        createdAt: now,
      },
    });
  }
  const personalCapacity = rider.capacityOverride ?? stage.capacity;
  return {
    stage: stage.stage,
    stageCapacity: stage.capacity,
    capacityOverride: rider.capacityOverride,
    personalCapacity,
    globalAbsoluteCapacity: config.platformMaxConcurrentOrdersPerRider,
    effectiveCapacity: Math.min(personalCapacity, config.platformMaxConcurrentOrdersPerRider),
    firstNormalDeliveredAt: rider.firstNormalDeliveredAt,
  };
}

export async function recordFirstNormalDelivery(
  tx: Prisma.TransactionClient,
  riderId: string,
  now: Date,
  timeZone: string,
) {
  const updated = await tx.rider.updateMany({
    where: { id: riderId, firstNormalDeliveredAt: null },
    data: { firstNormalDeliveredAt: now },
  });
  if (updated.count === 1) {
    await tx.riderCapacityEvent.create({
      data: {
        riderId,
        type: RiderCapacityEventType.FIRST_DELIVERY_UPGRADE,
        stage: RiderCapacityStage.FIRST_DELIVERY_SAME_DAY,
        previousCapacity: 1,
        newCapacity: 2,
        reason: 'FIRST_NORMAL_DELIVERY_COMPLETED',
        stageEventKey: `${riderId}:FIRST_DELIVERY_UPGRADE`,
        metadata: { timeZone },
        createdAt: now,
      },
    });
  }
}

export async function getMyCapacity(
  prisma: PrismaClient,
  actor: Actor,
  appConfig: Pick<AppConfig, 'campusTimeZone'>,
  now = new Date(),
) {
  if (!actor.riderId) throw notFound('Rider');
  const { config } = await loadPolicyConfig(prisma);
  const capacity = await resolveRiderCapacity(prisma, actor.riderId, config, appConfig.campusTimeZone, now);
  const [activeHeldOrders, events] = await Promise.all([
    prisma.deliveryTask.count({ where: { riderId: actor.riderId, status: { in: ['CLAIMED', 'PICKED_UP'] } } }),
    prisma.riderCapacityEvent.findMany({
      where: { riderId: actor.riderId },
      select: { id: true, type: true, stage: true, previousCapacity: true, newCapacity: true, reason: true, createdAt: true },
      orderBy: { createdAt: 'desc' },
      take: 20,
    }),
  ]);
  return { ...capacity, activeHeldOrders, events };
}

export async function setRiderCapacityOverride(
  prisma: PrismaClient,
  actor: Actor,
  riderId: string,
  capacityOverride: number | null,
  reason: string,
  appConfig: Pick<AppConfig, 'campusTimeZone'>,
  now = new Date(),
) {
  requireAdminLevel(actor, ['SUPER_ADMIN']);
  const { config } = await loadPolicyConfig(prisma);
  if (
    capacityOverride !== null
    && (!Number.isSafeInteger(capacityOverride) || capacityOverride < 1 || capacityOverride > config.platformMaxConcurrentOrdersPerRider)
  ) {
    throw badRequest('INVALID_RIDER_CAPACITY', 'Rider capacity override must be between 1 and the global absolute capacity');
  }
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "Rider" WHERE "id" = ${riderId}::uuid FOR UPDATE`;
    const before = await resolveRiderCapacity(tx, riderId, config, appConfig.campusTimeZone, now);
    await tx.rider.update({ where: { id: riderId }, data: { capacityOverride } });
    const newPersonalCapacity = capacityOverride ?? before.stageCapacity;
    await tx.riderCapacityEvent.create({
      data: {
        riderId,
        type: capacityOverride === null ? RiderCapacityEventType.ADMIN_OVERRIDE_CLEARED : RiderCapacityEventType.ADMIN_OVERRIDE_SET,
        stage: before.stage,
        previousCapacity: before.personalCapacity,
        newCapacity: newPersonalCapacity,
        actorId: actor.id,
        reason,
        metadata: { previousOverride: before.capacityOverride, newOverride: capacityOverride },
        createdAt: now,
      },
    });
    return {
      ...before,
      capacityOverride,
      personalCapacity: newPersonalCapacity,
      effectiveCapacity: Math.min(newPersonalCapacity, config.platformMaxConcurrentOrdersPerRider),
    };
  });
}
