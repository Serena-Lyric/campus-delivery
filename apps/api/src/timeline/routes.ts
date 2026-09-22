import type { PrismaClient } from '@prisma/client';
import { Type } from '@sinclair/typebox';
import type { FastifyInstance } from 'fastify';
import { actorOf, authGuard } from '../auth/auth.js';
import type { AppConfig } from '../config.js';
import { getOrderTimeline } from './service.js';

const OrderIdParams = Type.Object({ orderId: Type.String({ format: 'uuid' }) });

export async function registerTimelineRoutes(app: FastifyInstance, prisma: PrismaClient, config: AppConfig) {
  const authenticated = authGuard(prisma, config);
  app.get<{ Params: { orderId: string } }>('/orders/:orderId/timeline', {
    preHandler: authenticated,
    schema: { tags: ['timeline'], params: OrderIdParams },
  }, async (request) => getOrderTimeline(prisma, actorOf(request), request.params.orderId));
}
