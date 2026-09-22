import { VerificationPurpose, type PrismaClient } from '@prisma/client';
import { Type } from '@sinclair/typebox';
import type { FastifyInstance } from 'fastify';
import { actorOf, authGuard } from '../auth/auth.js';
import type { AppConfig } from '../config.js';
import { issueVerificationCode, verifyPickupCode } from './service.js';

const OrderIdParams = Type.Object({ orderId: Type.String({ format: 'uuid' }) });
const TaskIdParams = Type.Object({ taskId: Type.String({ format: 'uuid' }) });
const CodeBody = Type.Object({ code: Type.String({ pattern: '^[0-9]{6}$' }) });

export async function registerVerificationRoutes(app: FastifyInstance, prisma: PrismaClient, config: AppConfig) {
  const customer = authGuard(prisma, config, ['CUSTOMER']);
  const merchant = authGuard(prisma, config, ['MERCHANT']);
  const rider = authGuard(prisma, config, ['RIDER']);

  app.post<{ Params: { orderId: string } }>('/orders/:orderId/delivery-code', {
    preHandler: customer,
    schema: { tags: ['verification'], params: OrderIdParams },
  }, async (request, reply) => reply.status(201).send(await issueVerificationCode(
    prisma,
    actorOf(request),
    request.params.orderId,
    VerificationPurpose.DELIVERY,
  )));

  app.post<{ Params: { orderId: string } }>('/orders/:orderId/pickup-code', {
    preHandler: merchant,
    schema: { tags: ['verification'], params: OrderIdParams },
  }, async (request, reply) => reply.status(201).send(await issueVerificationCode(
    prisma,
    actorOf(request),
    request.params.orderId,
    VerificationPurpose.PICKUP,
  )));

  app.post<{ Params: { taskId: string }; Body: { code: string } }>('/delivery-tasks/:taskId/verify-pickup-code', {
    preHandler: rider,
    schema: { tags: ['verification'], params: TaskIdParams, body: CodeBody },
  }, async (request) => verifyPickupCode(
    prisma,
    actorOf(request),
    request.params.taskId,
    request.body.code,
  ));
}
