import type { PrismaClient } from '@prisma/client';
import { Type } from '@sinclair/typebox';
import type { FastifyInstance } from 'fastify';
import { actorOf, authGuard } from '../auth/auth.js';
import type { AppConfig } from '../config.js';
import { listRiderSettlements } from './service.js';

const Pagination = Type.Object({
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, default: 20 })),
  offset: Type.Optional(Type.Integer({ minimum: 0, default: 0 })),
});

export async function registerSettlementRoutes(app: FastifyInstance, prisma: PrismaClient, config: AppConfig) {
  const rider = authGuard(prisma, config, ['RIDER']);
  app.get<{ Querystring: { limit?: number; offset?: number } }>('/riders/me/settlements', {
    preHandler: rider,
    schema: { tags: ['settlements'], querystring: Pagination },
  }, async (request) => listRiderSettlements(
    prisma,
    actorOf(request),
    request.query.limit ?? 20,
    request.query.offset ?? 0,
  ));
}
