import { ExceptionType, type PrismaClient } from '@prisma/client';
import { Type } from '@sinclair/typebox';
import type { FastifyInstance } from 'fastify';
import { actorOf, authGuard } from '../auth/auth.js';
import type { AppConfig } from '../config.js';
import { createExceptionEvent } from './service.js';

const OrderIdParams = Type.Object({ orderId: Type.String({ format: 'uuid' }) });

export async function registerExceptionRoutes(app: FastifyInstance, prisma: PrismaClient, config: AppConfig) {
  const authenticated = authGuard(prisma, config);
  app.post<{
    Params: { orderId: string };
    Body: { type: ExceptionType; description: string; evidenceIds?: string[] };
  }>('/orders/:orderId/exceptions', {
    preHandler: authenticated,
    schema: {
      tags: ['exceptions'],
      params: OrderIdParams,
      body: Type.Object({
        type: Type.Enum(ExceptionType),
        description: Type.String({ minLength: 1, maxLength: 1000 }),
        evidenceIds: Type.Optional(Type.Array(Type.String({ format: 'uuid' }), { maxItems: 20 })),
      }),
    },
  }, async (request, reply) => reply.status(201).send(await createExceptionEvent(
    prisma,
    actorOf(request),
    request.params.orderId,
    request.body,
  )));
}
