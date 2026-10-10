import type { PrismaClient } from '@prisma/client';
import { Type } from '@sinclair/typebox';
import type { FastifyInstance } from 'fastify';
import { actorOf, adminGuard } from '../auth/auth.js';
import type { AppConfig } from '../config.js';
import { getOrderFinanceProjection } from './service.js';

export async function registerFinanceRoutes(app: FastifyInstance, prisma: PrismaClient, config: AppConfig) {
  app.get<{ Params: { orderId: string } }>('/admin/finance/orders/:orderId/projection', {
    preHandler: adminGuard(prisma, config, ['SUPER_ADMIN']),
    schema: { tags: ['finance'], description: 'Read-only development accounting projection. Estimates are platform costs, never verified fees or withdrawable cash.',
      params: Type.Object({ orderId: Type.String({ format: 'uuid' }) }) },
  }, async (request) => getOrderFinanceProjection(prisma, actorOf(request), request.params.orderId));
}
