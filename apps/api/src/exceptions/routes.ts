import { ExceptionType, type PrismaClient } from '@prisma/client';
import { Type } from '@sinclair/typebox';
import type { FastifyInstance } from 'fastify';
import { actorOf, authGuard } from '../auth/auth.js';
import type { AppConfig } from '../config.js';
import { createExceptionEvent } from './service.js';

const OrderIdParams = Type.Object({ orderId: Type.String({ format: 'uuid' }) });
const GeneralExceptionType = Type.Exclude(
  Type.Enum(ExceptionType),
  Type.Union([
    Type.Literal(ExceptionType.SEVERE_FOOD_DAMAGE),
    Type.Literal(ExceptionType.FOOD_LOST),
  ]),
);

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
        type: GeneralExceptionType,
        description: Type.String({ minLength: 1, maxLength: 1000 }),
        evidenceIds: Type.Optional(Type.Array(Type.String({ format: 'uuid' }), { maxItems: 20 })),
      }),
    },
  }, async (request, reply) => {
    const event = await createExceptionEvent(prisma, actorOf(request), request.params.orderId, request.body);
    return reply.status(201).send({
      id: event.id,
      orderId: event.orderId,
      orderStatus: event.orderStatus,
      type: event.type,
      description: event.description,
      createdAt: event.createdAt,
      evidences: event.evidences.map((evidence) => ({
        id: evidence.id,
        evidenceType: evidence.evidenceType,
        orderStage: evidence.orderStage,
        createdAt: evidence.createdAt,
      })),
    });
  });
}
