import type { PrismaClient } from '@prisma/client';
import { Type } from '@sinclair/typebox';
import type { FastifyInstance } from 'fastify';
import { actorOf, authGuard } from '../auth/auth.js';
import type { AppConfig } from '../config.js';
import { adjustRiderTip, repriceOrder } from './service.js';
import { getOrderPricingView } from './views.js';
import { badRequest } from '../shared/errors.js';
import { getMerchantBaseQuote, updateMerchantBaseQuote } from './merchant-quote.js';
import { maxStoredMinor } from './config.js';

const OrderIdParams = Type.Object({ orderId: Type.String({ format: 'uuid' }) });

export async function registerMarketPricingRoutes(app: FastifyInstance, prisma: PrismaClient, config: AppConfig) {
  const merchant = authGuard(prisma, config, ['MERCHANT']);
  const customer = authGuard(prisma, config, ['CUSTOMER']);

  app.get('/merchant/base-delivery-quote', {
    preHandler: merchant, schema: { tags: ['pricing'], description: 'Own merchant future reference quote and audit history; not merchant funding.' },
  }, async (request) => getMerchantBaseQuote(prisma, actorOf(request)));

  app.put<{ Body: { baseDeliveryPriceMinor: number; expectedVersion: number; reason: string } }>('/merchant/base-delivery-quote', {
    preHandler: merchant,
    preValidation: async (request) => {
      // Fastify otherwise strips additional fields; reject cross-store/order edit intent explicitly.
      if (request.body && Object.keys(request.body).some((key) => !['baseDeliveryPriceMinor', 'expectedVersion', 'reason'].includes(key))) {
        throw badRequest('INVALID_QUOTE_FIELDS', 'Only your own future base quote, expectedVersion and reason can be submitted');
      }
    },
    schema: {
      tags: ['pricing'], description: 'Changes only future orders; created/paid/claimed order prices remain unchanged.',
      body: Type.Object({
        baseDeliveryPriceMinor: Type.Integer({ minimum: 0, maximum: 1_073_741_823 }),
        expectedVersion: Type.Integer({ minimum: 0, maximum: maxStoredMinor - 1 }),
        reason: Type.String({ minLength: 1, maxLength: 500, pattern: '\\S' }),
      }, { additionalProperties: false }),
    },
  }, async (request) => updateMerchantBaseQuote(prisma, actorOf(request), request.body));

  app.patch<{
    Params: { orderId: string };
    Body: { newRescueContributionMinor?: number; newMinor?: number; reason?: string };
  }>('/merchant/orders/:orderId/delivery-quote', {
    preHandler: merchant,
    schema: {
      tags: ['pricing'],
      description: 'Legacy URL for real merchant rescue contribution only; never edits base price. Rejects claimed tasks, preserves original user price and claim deadline.',
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
