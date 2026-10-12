import { DeliveryMethod, type PrismaClient } from '@prisma/client';
import { Type } from '@sinclair/typebox';
import type { FastifyInstance } from 'fastify';
import { actorOf, adminGuard, authGuard } from '../auth/auth.js';
import type { AppConfig } from '../config.js';
import { previewOrderQuote, type CheckoutInput } from './quote.js';
import {
  cancelOrder,
  confirmOrder,
  createOrder,
  getOrder,
  listCustomerOrders,
  markOrderException,
  markOrderReady,
} from './service.js';

const OrderIdParams = Type.Object({ orderId: Type.String({ format: 'uuid' }) });
const Pagination = Type.Object({
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, default: 20 })),
  offset: Type.Optional(Type.Integer({ minimum: 0, default: 0 })),
});
const ReasonBody = Type.Object({ reason: Type.Optional(Type.String({ minLength: 1, maxLength: 500 })) });
const CheckoutBody = Type.Object({
  merchantId: Type.String({ format: 'uuid' }),
  destinationLocationId: Type.String({ format: 'uuid' }),
  deliveryMethod: Type.Enum(DeliveryMethod),
  items: Type.Array(Type.Object({
    productId: Type.String({ format: 'uuid' }),
    quantity: Type.Integer({ minimum: 1, maximum: 99 }),
  }, { additionalProperties: false }), { minItems: 1, maxItems: 50 }),
  expectedQuoteToken: Type.Optional(Type.String({ pattern: '^[0-9a-f]{64}$', description: 'Confirmation from POST /orders/price-preview; required in reference-BPS mode, checked whenever provided. This is not proof of payment.' })),
}, { additionalProperties: false });

export async function registerOrderRoutes(app: FastifyInstance, prisma: PrismaClient, config: AppConfig) {
  const anyUser = authGuard(prisma, config);
  const customer = authGuard(prisma, config, ['CUSTOMER']);
  const merchant = authGuard(prisma, config, ['MERCHANT']);
  const admin = adminGuard(prisma, config);

  app.post<{ Body: CheckoutInput }>('/orders/price-preview', {
    preHandler: customer,
    schema: { tags: ['pricing'], description: 'Read-only customer checkout preview; no order or payment is created.', body: CheckoutBody },
  }, async (request) => previewOrderQuote(prisma, actorOf(request), request.body, config.campusTimeZone));

  app.post<{ Body: CheckoutInput }>('/orders', {
    preHandler: customer,
    schema: {
      tags: ['orders'],
      description: 'Creates a CREATED development quote snapshot, not a payment success. Reference-BPS pricing requires confirmed preview token.',
      body: CheckoutBody,
    },
  }, async (request, reply) => {
    const actor = actorOf(request);
    const created = await createOrder(prisma, actor, request.body, config.campusTimeZone);
    return reply.status(201).send(await getOrder(prisma, actor, created.id));
  });

  app.get<{ Querystring: { limit?: number; offset?: number } }>('/orders/my', {
    preHandler: customer,
    schema: { tags: ['orders'], querystring: Pagination },
  }, async (request) => listCustomerOrders(prisma, actorOf(request), request.query.limit ?? 20, request.query.offset ?? 0));

  app.get<{ Params: { orderId: string } }>('/orders/:orderId', {
    preHandler: anyUser,
    schema: { tags: ['orders'], params: OrderIdParams },
  }, async (request) => getOrder(prisma, actorOf(request), request.params.orderId));

  app.post<{ Params: { orderId: string }; Body: { reason?: string } }>('/orders/:orderId/cancel', {
    preHandler: customer,
    schema: { tags: ['orders'], params: OrderIdParams, body: ReasonBody },
  }, async (request) => {
    const actor = actorOf(request);
    await cancelOrder(prisma, actor, request.params.orderId, request.body.reason);
    return getOrder(prisma, actor, request.params.orderId);
  });

  app.post<{ Params: { orderId: string } }>('/merchant/orders/:orderId/confirm', {
    preHandler: merchant,
    schema: { tags: ['merchant'], params: OrderIdParams },
  }, async (request) => {
    const actor = actorOf(request);
    await confirmOrder(prisma, actor, request.params.orderId);
    return getOrder(prisma, actor, request.params.orderId);
  });

  app.post<{ Params: { orderId: string } }>('/merchant/orders/:orderId/ready', {
    preHandler: merchant,
    schema: { tags: ['merchant'], params: OrderIdParams },
  }, async (request) => {
    const actor = actorOf(request);
    await markOrderReady(prisma, actor, request.params.orderId);
    return getOrder(prisma, actor, request.params.orderId);
  });

  app.post<{ Params: { orderId: string }; Body: { reason?: string } }>('/admin/orders/:orderId/exception', {
    preHandler: admin,
    schema: { tags: ['admin'], params: OrderIdParams, body: ReasonBody },
  }, async (request) => {
    const actor = actorOf(request);
    const reason = request.body.reason ?? 'Marked as exception by administrator';
    await markOrderException(
      prisma,
      actor,
      request.params.orderId,
      reason,
    );
    return getOrder(prisma, actor, request.params.orderId);
  });
}
