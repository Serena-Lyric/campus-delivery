import type { PrismaClient } from '@prisma/client';
import { Type } from '@sinclair/typebox';
import type { FastifyInstance } from 'fastify';
import { actorOf, authGuard } from '../auth/auth.js';
import type { AppConfig } from '../config.js';
import { getOrderPricingView } from './views.js';

const OrderIdParams = Type.Object({ orderId: Type.String({ format: 'uuid' }) });

export async function registerPricingViewRoutes(app: FastifyInstance, prisma: PrismaClient, config: AppConfig) {
  const authenticated = authGuard(prisma, config);
  app.get<{ Params: { orderId: string } }>('/orders/:orderId/pricing', {
    preHandler: authenticated,
    schema: { tags: ['pricing'], params: OrderIdParams },
  }, async (request) => getOrderPricingView(prisma, actorOf(request), request.params.orderId));
}
