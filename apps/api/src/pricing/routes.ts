import type { PrismaClient } from '@prisma/client';
import { Type } from '@sinclair/typebox';
import type { FastifyInstance } from 'fastify';
import { actorOf, authGuard } from '../auth/auth.js';
import type { AppConfig } from '../config.js';
import { adjustRiderTip, repriceOrder } from './service.js';
import { getOrderPricingView } from './views.js';
import { badRequest } from '../shared/errors.js';

const OrderIdParams = Type.Object({ orderId: Type.String({ format: 'uuid' }) });

export async function registerMarketPricingRoutes(app: FastifyInstance, prisma: PrismaClient, config: AppConfig) {
  const merchant = authGuard(prisma, config, ['MERCHANT']);
  const customer = authGuard(prisma, config, ['CUSTOMER']);

  app.patch<{
    Params: { orderId: string };
    Body: { newRescueContributionMinor?: number; newMinor?: number; reason?: string };
  }>('/merchant/orders/:orderId/delivery-quote', {
    preHandler: merchant,
    schema: {
      tags: ['pricing'],
      params: OrderIdParams,
      body: Type.Object({
        newRescueContributionMinor: Type.Optional(Type.Integer({ minimum: 1, description: 'New total merchant rescue contribution; 100% passes through to rider' })),
        newMinor: Type.Optional(Type.Integer({ minimum: 1, description: 'Deprecated alias for newRescueContributionMinor' })),
        reason: Type.Optional(Type.String({ minLength: 1, maxLength: 500 })),
      }),
    },
  }, async (request) => {
    const actor = actorOf(request);
    const newMinor = request.body.newRescueContributionMinor ?? request.body.newMinor;
    if (newMinor === undefined) throw badRequest('MISSING_RESCUE_CONTRIBUTION', 'newRescueContributionMinor is required');
    await repriceOrder(prisma, actor, request.params.orderId, newMinor, request.body.reason);
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
