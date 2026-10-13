import { ExceptionType, type PrismaClient } from '@prisma/client';
import { Type } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import type { FastifyInstance } from 'fastify';
import { actorOf, authGuard } from '../auth/auth.js';
import type { AppConfig } from '../config.js';
import { createExceptionEvent } from './service.js';
import { applyPreparationAction, preparationActionSchemas, preparationUuid } from '../orders/preparation-control.js';
import { badRequest } from '../shared/errors.js';
import { GoodsObjectionBody, reportGoodsObjection, type ObjectionInput } from '../orders/order-change.js';

const OrderIdParams = Type.Object({ orderId: Type.String({ format: 'uuid' }) });
const GeneralExceptionType = Type.Exclude(
  Type.Enum(ExceptionType),
  Type.Union([
    Type.Literal(ExceptionType.SEVERE_FOOD_DAMAGE),
    Type.Literal(ExceptionType.FOOD_LOST),
    Type.Literal('MERCHANT_PREPARATION_UNAVAILABLE'),
    Type.Literal('GOODS_CHANGE_OBJECTION'),
  ]),
);

export async function registerExceptionRoutes(app: FastifyInstance, prisma: PrismaClient, config: AppConfig) {
  const authenticated = authGuard(prisma, config);
  app.post<{
    Params: { orderId: string };
    Body: { type: ExceptionType; description: string; evidenceIds?: string[]; assignmentId?: string; expectedVersion?: number; requestKey?: string; noticeId?: string };
  }>('/orders/:orderId/exceptions', {
    preHandler: authenticated,
    preValidation: async (request) => {
      if (request.body?.type === 'GOODS_CHANGE_OBJECTION' && !Value.Check(GoodsObjectionBody, request.body)) throw badRequest('INVALID_GOODS_REPORT', 'Bound goods report fields required');
      if (request.body?.type === 'MERCHANT_PREPARATION_UNAVAILABLE' && !Value.Check(Type.Object({ type: Type.Literal('MERCHANT_PREPARATION_UNAVAILABLE'),
        description: preparationActionSchemas.REPORT_UNABLE.properties.reason, assignmentId: preparationUuid(),
        expectedVersion: preparationActionSchemas.REPORT_UNABLE.properties.expectedVersion, requestKey: preparationUuid() }, { additionalProperties: false }), request.body)) throw badRequest('INVALID_PREPARATION_REPORT', 'Bound preparation report fields required');
    },
    schema: {
      tags: ['exceptions'],
      params: OrderIdParams,
      body: Type.Union([GoodsObjectionBody, Type.Object({
        type: GeneralExceptionType,
        description: Type.String({ minLength: 1, maxLength: 1000 }),
        evidenceIds: Type.Optional(Type.Array(Type.String({ format: 'uuid' }), { maxItems: 20 })),
      }), Type.Object({ type: Type.Literal('MERCHANT_PREPARATION_UNAVAILABLE'), description: preparationActionSchemas.REPORT_UNABLE.properties.reason,
        assignmentId: preparationUuid(), expectedVersion: preparationActionSchemas.REPORT_UNABLE.properties.expectedVersion, requestKey: preparationUuid() }, { additionalProperties: false })]),
    },
  }, async (request, reply) => {
    if (request.body.type === 'GOODS_CHANGE_OBJECTION') return reply.status(201).send(await reportGoodsObjection(prisma, actorOf(request), request.params.orderId, request.body as ObjectionInput));
    if (request.body.type === 'MERCHANT_PREPARATION_UNAVAILABLE') {
      return reply.status(201).send(await applyPreparationAction(prisma, actorOf(request), request.params.orderId, 'REPORT_UNABLE', {
        reason: request.body.description, assignmentId: request.body.assignmentId!, expectedVersion: request.body.expectedVersion!, requestKey: request.body.requestKey!,
      }));
    }
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
