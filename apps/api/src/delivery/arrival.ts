import type { OrderStatus, PrismaClient } from '@prisma/client';
import { Type, type Static } from '@sinclair/typebox';
import type { Actor } from '../auth/auth.js';
import { conflict, forbidden, notFound } from '../shared/errors.js';
import { lockPickupOrder } from './pickup-code.js';

export const ArrivalBody = Type.Object({ assignmentId: Type.String({ pattern: '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' }) }, { additionalProperties: false });
export type ArrivalInput = Static<typeof ArrivalBody>;
export const ArrivalView = Type.Object({ assignmentId: Type.String({ format: 'uuid' }), arrivedAt: Type.String({ format: 'date-time' }),
  replayed: Type.Boolean(), selfReported: Type.Boolean(), onsiteVerified: Type.Boolean() }, { additionalProperties: false });

export function arrivalElapsedView(arrivedAt: Date | null, readyAt: Date | null, handedOffAt: Date | null, endedAt: Date | null, now: Date, handoffDisputed = false, orderStatus: OrderStatus = 'CLAIMED') {
  const terminal = ['DELIVERED', 'EXCEPTION', 'CANCELLED', 'NO_RIDER_ACCEPTED'].includes(orderStatus);
  // A later rider's READY declaration must not become a node of an earlier ended assignment.
  if (endedAt && readyAt && readyAt > endedAt) readyAt = null;
  const seconds = (start: Date | null, end: Date | null) => start && end ? Math.max(0, Math.floor((end.getTime() - start.getTime()) / 1000)) : null;
  return {
    arrivedAt, readyAt, handedOffAt,
    arrivalToReadySeconds: seconds(arrivedAt, readyAt),
    readyToHandoffSeconds: seconds(readyAt, handedOffAt),
    totalElapsedSeconds: seconds(arrivedAt, handedOffAt ?? endedAt ?? (terminal ? null : now)),
    ongoing: Boolean(!terminal && arrivedAt && !handedOffAt && !endedAt),
    endTimeUnverified: Boolean(terminal && arrivedAt && !handedOffAt && !endedAt),
    handoffDisputed,
    selfReported: true,
    onsiteVerified: false,
    measurementLabel: '自报节点之间的经过时长，不是连续现场等待证明',
  };
}

export async function markRiderArrival(prisma: PrismaClient, actor: Actor, taskId: string, assignmentId: string, clock = () => new Date()) {
  if (actor.role !== 'RIDER' || !actor.riderId) throw forbidden();
  return prisma.$transaction(async (tx) => {
    const identity = await tx.deliveryTask.findUnique({ where: { id: taskId }, select: { orderId: true } });
    if (!identity) throw notFound('Delivery task');
    // Same order -> task lock order as handoff; cancellation and replacement claims also take these locks.
    const task = await lockPickupOrder(tx, identity.orderId);
    if (task.riderId !== actor.riderId) throw forbidden();
    const assignment = task.assignments.find((a) => a.id === assignmentId && a.riderId === actor.riderId && a.status === 'ACTIVE');
    if (!assignment) throw conflict('ARRIVAL_ASSIGNMENT_CHANGED', 'Refresh the current active assignment');
    if (assignment.rider.userId !== actor.id) throw forbidden();
    if (task.status !== 'CLAIMED' || task.order.status !== 'CLAIMED' || task.pickedUpAt) throw conflict('ARRIVAL_NOT_ALLOWED', 'Arrival can only be recorded before pickup on a current claim');
    if (assignment.merchantArrivedAt) return { assignmentId, arrivedAt: assignment.merchantArrivedAt, replayed: true, selfReported: true, onsiteVerified: false };
    const now = clock();
    const changed = await tx.deliveryAssignment.updateMany({ where: { id: assignmentId, status: 'ACTIVE', merchantArrivedAt: null }, data: { merchantArrivedAt: now } });
    if (changed.count !== 1) throw conflict('ARRIVAL_ASSIGNMENT_CHANGED', 'Arrival or assignment changed concurrently');
    await tx.orderEvent.create({ data: { orderId: task.orderId, eventType: 'RIDER_ARRIVED', actorType: 'USER', fromStatus: task.order.status,
      toStatus: task.order.status, operatorId: actor.id, operatorRole: actor.role, createdAt: now,
      metadata: { assignmentId, selfReported: true, onsiteVerified: false } } });
    return { assignmentId, arrivedAt: now, replayed: false, selfReported: true, onsiteVerified: false };
  });
}
