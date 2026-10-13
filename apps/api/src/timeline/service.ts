import type { PrismaClient } from '@prisma/client';
import type { Actor } from '../auth/auth.js';
import { assertOrderAccess } from '../orders/access.js';
import { notFound } from '../shared/errors.js';

type TimelineItem = {
  id: string;
  source: 'ORDER_EVENT' | 'EVIDENCE' | 'EXCEPTION';
  type: string;
  timestamp: Date;
  actorRole: string | null;
  summary: string;
  details: Record<string, unknown>;
};

const sourceRank: Record<TimelineItem['source'], number> = {
  ORDER_EVENT: 0,
  EVIDENCE: 1,
  EXCEPTION: 2,
};

export async function getOrderTimeline(prisma: PrismaClient, actor: Actor, orderId: string) {
  return prisma.$transaction(async (tx) => {
  const order = await tx.order.findUnique({
    where: { id: orderId },
    include: {
      deliveryTask: true,
      assignments: { select: { riderId: true, status: true, endedAt: true } },
    },
  });
  if (!order) throw notFound('Order');
  assertOrderAccess(actor, order);

  const [events, evidence, exceptions] = await Promise.all([
    tx.orderEvent.findMany({ where: { orderId } }),
    tx.evidence.findMany({ where: { orderId } }),
    tx.exceptionEvent.findMany({ where: { orderId } }),
  ]);

  const currentRider = actor.role === 'RIDER' && order.deliveryTask?.riderId === actor.riderId
    && order.assignments.some((a) => a.riderId === actor.riderId && a.status === 'ACTIVE');
  const latestEndedAt = order.assignments.filter((a) => a.riderId === actor.riderId && a.endedAt)
    .reduce<Date | null>((latest, a) => !latest || a.endedAt! > latest ? a.endedAt : latest, null);
  const hiddenGoodsEvents = new Set(exceptions.filter((e) => actor.role === 'RIDER' && !currentRider && e.type === 'GOODS_CHANGE_OBJECTION'
    && e.reporterId !== actor.id && (!latestEndedAt || e.createdAt > latestEndedAt)).map((e) => e.id));

  const items: TimelineItem[] = [
    ...events.map((event) => ({
      id: event.id,
      source: 'ORDER_EVENT' as const,
      type: event.eventType,
      timestamp: event.createdAt,
      actorRole: event.operatorRole,
      summary: event.reason ?? event.eventType.replaceAll('_', ' ').toLowerCase(),
      details: {
        fromStatus: event.fromStatus,
        toStatus: event.toStatus,
        actorType: event.actorType,
        ...(actor.role === 'ADMIN' && event.metadata && typeof event.metadata === 'object'
          ? { metadata: event.metadata }
          : {}),
      },
    })),
    ...evidence.filter((item) => !item.exceptionEventId || !hiddenGoodsEvents.has(item.exceptionEventId)).map((item) => ({
      id: item.id,
      source: 'EVIDENCE' as const,
      type: item.evidenceType,
      timestamp: item.createdAt,
      actorRole: item.actorRole,
      summary: item.note ?? 'Evidence recorded',
      details: {
        orderStage: item.orderStage,
        hasMedia: Boolean(item.mediaReference),
        ...(actor.role === 'ADMIN' && item.metadata && typeof item.metadata === 'object'
          ? { metadata: item.metadata }
          : {}),
      },
    })),
    ...exceptions.filter((item) => !hiddenGoodsEvents.has(item.id)).map((item) => ({
      id: item.id,
      source: 'EXCEPTION' as const,
      type: item.type,
      timestamp: item.createdAt,
      actorRole: item.reporterRole,
      summary: item.description,
      details: {
        orderStatus: item.orderStatus,
        resolved: Boolean(item.resolvedAt),
      },
    })),
  ];

  return items.sort((left, right) => (
    left.timestamp.getTime() - right.timestamp.getTime()
    || sourceRank[left.source] - sourceRank[right.source]
    || left.id.localeCompare(right.id)
  ));
  }, { isolationLevel: 'RepeatableRead' });
}
