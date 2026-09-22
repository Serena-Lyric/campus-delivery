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
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: {
      deliveryTask: true,
      assignments: { select: { riderId: true } },
    },
  });
  if (!order) throw notFound('Order');
  assertOrderAccess(actor, order);

  const [events, evidence, exceptions] = await Promise.all([
    prisma.orderEvent.findMany({ where: { orderId } }),
    prisma.evidence.findMany({ where: { orderId } }),
    prisma.exceptionEvent.findMany({ where: { orderId } }),
  ]);

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
    ...evidence.map((item) => ({
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
    ...exceptions.map((item) => ({
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
}
