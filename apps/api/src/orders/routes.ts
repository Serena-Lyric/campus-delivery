import { DeliveryMethod, type PrismaClient } from '@prisma/client';
import { Type } from '@sinclair/typebox';
import type { FastifyInstance } from 'fastify';
import { actorOf, authGuard } from '../auth/auth.js';
import type { AppConfig } from '../config.js';
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

export async function registerOrderRoutes(app: FastifyInstance, prisma: PrismaClient, config: AppConfig) {
  const anyUser = authGuard(prisma, config);
  const customer = authGuard(prisma, config, ['CUSTOMER']);
  const merchant = authGuard(prisma, config, ['MERCHANT']);
  const admin = authGuard(prisma, config, ['ADMIN']);

  app.post<{
    Body: {
      merchantId: string;
      destinationLocationId: string;
      deliveryMethod: DeliveryMethod;
      items: Array<{ productId: string; quantity: number }>;
    };
  }>('/orders', {
    preHandler: customer,
    schema: {
      tags: ['orders'],
      body: Type.Object({
        merchantId: Type.String({ format: 'uuid' }),
        destinationLocationId: Type.String({ format: 'uuid' }),
        deliveryMethod: Type.Enum(DeliveryMethod),
        items: Type.Array(Type.Object({
          productId: Type.String({ format: 'uuid' }),
          quantity: Type.Integer({ minimum: 1, maximum: 99 }),
        }), { minItems: 1, maxItems: 50 }),
      }),
    },
  }, async (request, reply) => reply.status(201).send(await createOrder(
    prisma,
    actorOf(request),
    request.body,
    config.campusTimeZone,
  )));

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
  }, async (request) => cancelOrder(prisma, actorOf(request), request.params.orderId, request.body.reason));

  app.post<{ Params: { orderId: string } }>('/merchant/orders/:orderId/confirm', {
    preHandler: merchant,
    schema: { tags: ['merchant'], params: OrderIdParams },
  }, async (request) => confirmOrder(prisma, actorOf(request), request.params.orderId));

  app.post<{ Params: { orderId: string } }>('/merchant/orders/:orderId/ready', {
    preHandler: merchant,
    schema: { tags: ['merchant'], params: OrderIdParams },
  }, async (request) => markOrderReady(prisma, actorOf(request), request.params.orderId));

  app.post<{ Params: { orderId: string }; Body: { reason?: string } }>('/admin/orders/:orderId/exception', {
    preHandler: admin,
    schema: { tags: ['admin'], params: OrderIdParams, body: ReasonBody },
  }, async (request) => markOrderException(
    prisma,
    actorOf(request),
    request.params.orderId,
    request.body.reason ?? 'Marked as exception by administrator',
  ));
}
