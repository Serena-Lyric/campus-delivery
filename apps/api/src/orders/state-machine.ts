import {
  OrderEventActorType,
  OrderEventType,
  OrderStatus,
  type Prisma,
} from '@prisma/client';
import type { Actor } from '../auth/auth.js';
import { conflict } from '../shared/errors.js';

const transitions: Readonly<Record<OrderStatus, readonly OrderStatus[]>> = {
  CREATED: [OrderStatus.MERCHANT_PENDING, OrderStatus.CANCELLED, OrderStatus.EXCEPTION],
  MERCHANT_PENDING: [OrderStatus.MERCHANT_CONFIRMED, OrderStatus.CANCELLED, OrderStatus.EXCEPTION],
  MERCHANT_CONFIRMED: [OrderStatus.READY_FOR_RIDER, OrderStatus.CANCELLED, OrderStatus.EXCEPTION],
  READY_FOR_RIDER: [OrderStatus.CLAIMED, OrderStatus.NO_RIDER_ACCEPTED, OrderStatus.CANCELLED, OrderStatus.EXCEPTION],
  CLAIMED: [OrderStatus.READY_FOR_RIDER, OrderStatus.PICKED_UP, OrderStatus.CANCELLED, OrderStatus.EXCEPTION],
  PICKED_UP: [OrderStatus.DELIVERED, OrderStatus.EXCEPTION],
  DELIVERED: [],
  NO_RIDER_ACCEPTED: [],
  CANCELLED: [],
  EXCEPTION: [],
};

export function assertTransition(from: OrderStatus, to: OrderStatus): void {
  if (!transitions[from].includes(to)) {
    throw conflict('ORDER_STATE_CONFLICT', `Order cannot transition from ${from} to ${to}`);
  }
}

type TransactionClient = Prisma.TransactionClient;

type TransitionOptions = {
  eventType?: OrderEventType;
  reason?: string;
  metadata?: Prisma.InputJsonValue;
};

export async function transitionOrder(
  tx: TransactionClient,
  orderId: string,
  from: OrderStatus,
  to: OrderStatus,
  actor: Pick<Actor, 'id' | 'role'> | null,
  options: TransitionOptions = {},
): Promise<void> {
  assertTransition(from, to);
  const updated = await tx.order.updateMany({ where: { id: orderId, status: from }, data: { status: to } });
  if (updated.count !== 1) {
    throw conflict('ORDER_STATE_CONFLICT', 'Order state changed before this action completed');
  }
  await tx.orderEvent.create({
    data: {
      orderId,
      eventType: options.eventType ?? OrderEventType.STATUS_CHANGED,
      actorType: actor ? OrderEventActorType.USER : OrderEventActorType.SYSTEM,
      fromStatus: from,
      toStatus: to,
      ...(actor ? { operatorId: actor.id, operatorRole: actor.role } : {}),
      ...(options.reason ? { reason: options.reason } : {}),
      ...(options.metadata !== undefined ? { metadata: options.metadata } : {}),
    },
  });
}
