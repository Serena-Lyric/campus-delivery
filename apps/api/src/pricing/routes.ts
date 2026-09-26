import type { PrismaClient } from '@prisma/client';
import { Type } from '@sinclair/typebox';
import type { FastifyInstance } from 'fastify';
import { actorOf, authGuard } from '../auth/auth.js';
import type { AppConfig } from '../config.js';
import { adjustRiderTip, repriceOrder } from './service.js';
import { getOrderPricingView } from './views.js';

const OrderIdParams = Type.Object({ orderId: Type.String({ format: 'uuid' }) });

export async function registerMarketPricingRoutes(app: FastifyInstance, prisma: PrismaClient, config: AppConfig) {
  const merchant = authGuard(prisma, config, ['MERCHANT']);
  const customer = authGuard(prisma, config, ['CUSTOMER']);

  app.patch<{
    Params: { orderId: string };
    Body: { newMinor: number; reason?: string };
  }>('/merchant/orders/:orderId/delivery-quote', {
    preHandler: merchant,
    schema: {
      tags: ['pricing'],
      params: OrderIdParams,
      body: Type.Object({
        newMinor: Type.Integer({ minimum: 0 }),
        reason: Type.Optional(Type.String({ minLength: 1, maxLength: 500 })),
      }),
    },
  }, async (request) => {
    const actor = actorOf(request);
    await repriceOrder(prisma, actor, request.params.orderId, request.body.newMinor, request.body.reason);
    return getOrderPricingView(prisma, actor, request.params.orderId);
  });

  app.post<{
    Params: { orderId: string };
    Body: { deltaMinor: number; reason?: string };
  }>('/orders/:orderId/rider-tip-adjustments', {
    preHandler: customer,
    schema: {
      tags: ['pricing'],
      params: OrderIdParams,
      body: Type.Object({
        deltaMinor: Type.Integer(),
        reason: Type.Optional(Type.String({ minLength: 1, maxLength: 500 })),
      }),
    },
  }, async (request, reply) => {
    const event = await adjustRiderTip(
      prisma,
      actorOf(request),
      request.params.orderId,
      request.body.deltaMinor,
      request.body.reason,
    );
    return reply.status(201).send({
      id: event.id,
      type: event.type,
      deltaMinor: event.deltaMinor,
      balanceAfterMinor: event.balanceAfterMinor,
      reason: event.reason,
      createdAt: event.createdAt,
    });
  });
}
