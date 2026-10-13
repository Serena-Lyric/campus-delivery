import {
  DeliveryAssignmentStatus,
  DeliveryTaskStatus,
  OrderEventType,
  OrderStatus,
  RiderRestrictionSource,
  RiderRestrictionStatus,
  RiderRestrictionType,
  type Prisma,
  type PrismaClient,
  type RiderCancellationReason,
} from '@prisma/client';
import { requireAdminLevel, type Actor } from '../auth/auth.js';
import type { AppConfig } from '../config.js';
import { loadPolicyConfig, type PolicyConfig } from '../merchant-policy/policies.js';
import { expireOpenDeliveryTask } from '../orders/lifecycle.js';
import { transitionOrder } from '../orders/state-machine.js';
import { conflict, forbidden, notFound } from '../shared/errors.js';
import { campusDay, nextCampusDayStart } from '../shared/time.js';

async function releaseExpiredRestrictions(tx: Prisma.TransactionClient, riderId: string, now: Date) {
  const expired = await tx.riderRestriction.findMany({
    where: { riderId, status: RiderRestrictionStatus.ACTIVE, endsAt: { lte: now } },
  });
  for (const restriction of expired) {
    await tx.riderRestriction.update({
      where: { id: restriction.id },
      data: { status: RiderRestrictionStatus.RELEASED, releasedAt: now },
    });
    await tx.riderRestrictionAudit.create({
      data: {
        restrictionId: restriction.id,
        previousStatus: restriction.status,
        newStatus: RiderRestrictionStatus.RELEASED,
        previousEndsAt: restriction.endsAt,
        newEndsAt: restriction.endsAt,
        reason: 'AUTOMATIC_EXPIRY',
        createdAt: now,
      },
    });
  }
}

async function createRestriction(
  tx: Prisma.TransactionClient,
  riderId: string,
  type: RiderRestrictionType,
  endsAt: Date,
  reason: string,
  source: RiderRestrictionSource,
  now: Date,
  actorId?: string,
) {
  const restriction = await tx.riderRestriction.create({
    data: { riderId, type, status: RiderRestrictionStatus.ACTIVE, source, reason, startsAt: now, endsAt },
  });
  await tx.riderRestrictionAudit.create({
    data: {
      restrictionId: restriction.id,
      ...(actorId ? { actorId } : {}),
      newStatus: RiderRestrictionStatus.ACTIVE,
      newEndsAt: endsAt,
      reason,
      createdAt: now,
    },
  });
  return restriction;
}

export async function assertRiderCanClaim(
  tx: Prisma.TransactionClient,
  riderId: string,
  now: Date,
) {
  await releaseExpiredRestrictions(tx, riderId, now);
  const active = await tx.riderRestriction.findFirst({
    where: { riderId, status: RiderRestrictionStatus.ACTIVE, endsAt: { gt: now } },
    orderBy: { endsAt: 'desc' },
  });
  if (active) throw conflict('RIDER_CLAIM_RESTRICTED', `Rider cannot claim new tasks until ${active.endsAt.toISOString()}`);
}

export async function cancelBeforePickup(
  prisma: PrismaClient,
  actor: Actor,
  taskId: string,
  input: { reason: RiderCancellationReason; note?: string },
  appConfig: Pick<AppConfig, 'campusTimeZone'>,
  now = new Date(),
) {
  if (!actor.riderId) throw forbidden();
  const riderId = actor.riderId;
  const { config } = await loadPolicyConfig(prisma);
  return prisma.$transaction(async (tx) => {
    const identity = await tx.deliveryTask.findUnique({ where: { id: taskId }, select: { orderId: true } });
    if (!identity) throw notFound('Delivery task');
    await tx.$queryRaw`SELECT "id" FROM "Rider" WHERE "id" = ${riderId}::uuid FOR UPDATE`;
    await tx.$queryRaw`SELECT "id" FROM "Order" WHERE "id" = ${identity.orderId}::uuid FOR UPDATE`;
    await tx.$queryRaw`SELECT "id" FROM "DeliveryTask" WHERE "id" = ${taskId}::uuid FOR UPDATE`;
    const task = await tx.deliveryTask.findUnique({
      where: { id: taskId },
      include: { order: true, assignments: { where: { status: DeliveryAssignmentStatus.ACTIVE } } },
    });
    if (!task) throw notFound('Delivery task');
    if (task.riderId !== riderId) throw forbidden();
    if (task.status !== DeliveryTaskStatus.CLAIMED || task.pickedUpAt) {
      throw conflict('PRE_PICKUP_CANCEL_NOT_ALLOWED', 'Responsibility-free cancellation is only available before pickup');
    }
    const assignment = task.assignments[0];
    if (!assignment) throw conflict('MISSING_ASSIGNMENT', 'Active delivery assignment is missing');

    const day = campusDay(now, appConfig.campusTimeZone);
    const rollingStart = new Date(now.getTime() - config.riderCancellationRollingWindowDays * 86_400_000);
    const [dailyBefore, rollingBefore, warningsBefore] = await Promise.all([
      tx.riderCancellationEvent.count({ where: { riderId, campusDay: day } }),
      tx.riderCancellationEvent.count({ where: { riderId, createdAt: { gte: rollingStart } } }),
      tx.riderCancellationEvent.count({ where: { riderId, createdAt: { gte: rollingStart }, warningIssued: true } }),
    ]);
    if (dailyBefore >= config.riderDailyFreeCancelLimit) {
      throw conflict('RIDER_DAILY_FREE_CANCEL_LIMIT', 'Daily responsibility-free cancellation limit has been reached');
    }
    const dailyCount = dailyBefore + 1;
    const rollingCount = rollingBefore + 1;
    const warningIssued = dailyCount === config.riderDailyFreeCancelLimit;
    const warningCount = warningsBefore + (warningIssued ? 1 : 0);

    await tx.deliveryAssignment.update({
      where: { id: assignment.id },
      data: { status: DeliveryAssignmentStatus.ABANDONED, endedAt: now, reason: `PRE_PICKUP:${input.reason}`, temporaryPersonalCapacityRelease: false },
    });
    await tx.deliveryTask.update({
      where: { id: task.id },
      data: { status: DeliveryTaskStatus.OPEN, riderId: null, claimedAt: null },
    });
    await transitionOrder(tx, task.orderId, task.order.status, OrderStatus.READY_FOR_RIDER, actor, {
      eventType: OrderEventType.RIDER_PRE_PICKUP_CANCELLED,
      reason: input.note ?? input.reason,
      metadata: { assignmentId: assignment.id, dailyCount, rollingCount, warningIssued },
    });
    const event = await tx.riderCancellationEvent.create({
      data: {
        riderId,
        taskId: task.id,
        orderId: task.orderId,
        assignmentId: assignment.id,
        reason: input.reason,
        ...(input.note ? { note: input.note } : {}),
        campusDay: day,
        dailyCount,
        rollingCount,
        warningIssued,
        createdAt: now,
      },
    });

    await releaseExpiredRestrictions(tx, riderId, now);
    const shouldPauseToday = warningIssued
      || (rollingCount >= config.riderCancellationCooldownThreshold && warningCount < config.riderWarningCooldownThreshold);
    if (shouldPauseToday) {
      await createRestriction(
        tx,
        riderId,
        RiderRestrictionType.SAME_DAY_NEW_CLAIM_PAUSE,
        nextCampusDayStart(now, appConfig.campusTimeZone),
        warningIssued ? 'DAILY_FREE_CANCEL_LIMIT_REACHED' : 'ROLLING_CANCELLATION_PAUSE',
        RiderRestrictionSource.AUTOMATIC,
        now,
      );
    }
    if (warningCount >= config.riderWarningCooldownThreshold) {
      await createRestriction(
        tx,
        riderId,
        RiderRestrictionType.ROLLING_WARNING_COOLDOWN,
        new Date(now.getTime() + config.riderWarningCooldownSeconds * 1000),
        'ROLLING_WARNING_THRESHOLD_REACHED',
        RiderRestrictionSource.AUTOMATIC,
        now,
      );
    } else if (rollingCount >= config.riderCancellationCooldownThreshold) {
      await createRestriction(
        tx,
        riderId,
        RiderRestrictionType.ROLLING_CANCELLATION_COOLDOWN,
        new Date(now.getTime() + config.riderCancellationCooldownSeconds * 1000),
        'ROLLING_CANCELLATION_THRESHOLD_REACHED',
        RiderRestrictionSource.AUTOMATIC,
        now,
      );
    }
    if (task.claimDeadline && now >= task.claimDeadline) await expireOpenDeliveryTask(tx, task.id, now);
    return {
      event: {
        id: event.id,
        reason: event.reason,
        note: event.note,
        dailyCount: event.dailyCount,
        rollingCount: event.rollingCount,
        warningIssued: event.warningIssued,
        createdAt: event.createdAt,
      },
      summary: await riderRestrictionSummaryTx(tx, riderId, config, appConfig.campusTimeZone, now),
    };
  });
}

async function riderRestrictionSummaryTx(
  prisma: PrismaClient | Prisma.TransactionClient,
  riderId: string,
  config: PolicyConfig,
  timeZone: string,
  now: Date,
) {
  const day = campusDay(now, timeZone);
  const rollingStart = new Date(now.getTime() - config.riderCancellationRollingWindowDays * 86_400_000);
  const [dailyCount, rollingCount, warningCount, restrictions] = await Promise.all([
    prisma.riderCancellationEvent.count({ where: { riderId, campusDay: day } }),
    prisma.riderCancellationEvent.count({ where: { riderId, createdAt: { gte: rollingStart } } }),
    prisma.riderCancellationEvent.count({ where: { riderId, createdAt: { gte: rollingStart }, warningIssued: true } }),
    prisma.riderRestriction.findMany({
      where: { riderId, status: RiderRestrictionStatus.ACTIVE, endsAt: { gt: now } },
      select: { id: true, type: true, source: true, reason: true, startsAt: true, endsAt: true },
      orderBy: { endsAt: 'desc' },
    }),
  ]);
  return { dailyCount, rollingCount, warningCount, restrictions };
}

export async function getMyRiderRestrictions(
  prisma: PrismaClient,
  actor: Actor,
  appConfig: Pick<AppConfig, 'campusTimeZone'>,
  now = new Date(),
) {
  if (!actor.riderId) throw forbidden();
  const { config } = await loadPolicyConfig(prisma);
  return riderRestrictionSummaryTx(prisma, actor.riderId, config, appConfig.campusTimeZone, now);
}

export async function createManualRestriction(
  prisma: PrismaClient,
  actor: Actor,
  riderId: string,
  endsAt: Date,
  reason: string,
  now = new Date(),
) {
  requireAdminLevel(actor, ['SUPER_ADMIN']);
  if (endsAt <= now) throw conflict('INVALID_RESTRICTION_WINDOW', 'Restriction must end in the future');
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "Rider" WHERE "id" = ${riderId}::uuid FOR UPDATE`;
    if (!await tx.rider.findUnique({ where: { id: riderId } })) throw notFound('Rider');
    await releaseExpiredRestrictions(tx, riderId, now);
    return createRestriction(tx, riderId, RiderRestrictionType.MANUAL, endsAt, reason, RiderRestrictionSource.ADMIN, now, actor.id);
  });
}

export async function getRiderRestrictionAdminView(
  prisma: PrismaClient,
  actor: Actor,
  riderId: string,
  appConfig: Pick<AppConfig, 'campusTimeZone'>,
  now = new Date(),
) {
  requireAdminLevel(actor, ['SUPER_ADMIN']);
  if (!await prisma.rider.findUnique({ where: { id: riderId }, select: { id: true } })) throw notFound('Rider');
  const { config } = await loadPolicyConfig(prisma);
  const [summary, cancellationEvents, restrictions] = await Promise.all([
    riderRestrictionSummaryTx(prisma, riderId, config, appConfig.campusTimeZone, now),
    prisma.riderCancellationEvent.findMany({
      where: { riderId },
      select: {
        id: true,
        orderId: true,
        taskId: true,
        reason: true,
        note: true,
        campusDay: true,
        dailyCount: true,
        rollingCount: true,
        warningIssued: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'desc' },
      take: 100,
    }),
    prisma.riderRestriction.findMany({
      where: { riderId },
      select: {
        id: true,
        type: true,
        status: true,
        source: true,
        reason: true,
        startsAt: true,
        endsAt: true,
        releasedAt: true,
        audits: {
          select: { id: true, actorId: true, previousStatus: true, newStatus: true, previousEndsAt: true, newEndsAt: true, reason: true, createdAt: true },
          orderBy: { createdAt: 'asc' },
        },
      },
      orderBy: { createdAt: 'desc' },
    }),
  ]);
  return { summary, cancellationEvents, restrictions };
}

export async function overrideRiderRestriction(
  prisma: PrismaClient,
  actor: Actor,
  restrictionId: string,
  input: { action: 'RELEASE' | 'EXTEND'; endsAt?: Date; reason: string },
  now = new Date(),
) {
  requireAdminLevel(actor, ['SUPER_ADMIN']);
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "RiderRestriction" WHERE "id" = ${restrictionId}::uuid FOR UPDATE`;
    const restriction = await tx.riderRestriction.findUnique({ where: { id: restrictionId } });
    if (!restriction) throw notFound('Rider restriction');
    const newStatus = input.action === 'RELEASE' ? RiderRestrictionStatus.OVERRIDDEN : RiderRestrictionStatus.ACTIVE;
    const newEndsAt = input.action === 'RELEASE' ? now : input.endsAt;
    if (!newEndsAt || (input.action === 'EXTEND' && newEndsAt <= now)) {
      throw conflict('INVALID_RESTRICTION_WINDOW', 'Extended restriction must end in the future');
    }
    const updated = await tx.riderRestriction.update({
      where: { id: restriction.id },
      data: {
        status: newStatus,
        endsAt: newEndsAt,
        releasedAt: input.action === 'RELEASE' ? now : null,
      },
    });
    await tx.riderRestrictionAudit.create({
      data: {
        restrictionId: restriction.id,
        actorId: actor.id,
        previousStatus: restriction.status,
        newStatus,
        previousEndsAt: restriction.endsAt,
        newEndsAt,
        reason: input.reason,
        createdAt: now,
      },
    });
    return updated;
  });
}
