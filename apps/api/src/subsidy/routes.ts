import type { PrismaClient } from '@prisma/client';
import { Type } from '@sinclair/typebox';
import type { FastifyInstance } from 'fastify';
import { actorOf, authGuard } from '../auth/auth.js';
import type { AppConfig } from '../config.js';
import { addPlatformSubsidy } from './service.js';

const OrderIdParams = Type.Object({ orderId: Type.String({ format: 'uuid' }) });

export async function registerSubsidyRoutes(app: FastifyInstance, prisma: PrismaClient, config: AppConfig) {
  const admin = authGuard(prisma, config, ['ADMIN']);
  app.post<{
    Params: { orderId: string };
    Body: { requestedMinor?: number; reason: string };
  }>('/admin/orders/:orderId/platform-subsidies', {
    preHandler: admin,
    schema: {
      tags: ['subsidy'],
      params: OrderIdParams,
      body: Type.Object({
        requestedMinor: Type.Optional(Type.Integer({ minimum: 1 })),
        reason: Type.String({ minLength: 1, maxLength: 500 }),
      }),
    },
  }, async (request, reply) => reply.status(201).send(await addPlatformSubsidy(
    prisma,
    actorOf(request),
    request.params.orderId,
    request.body,
  )));
}
