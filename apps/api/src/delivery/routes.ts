import type { PrismaClient } from '@prisma/client';
import { Type } from '@sinclair/typebox';
import type { FastifyInstance } from 'fastify';
import { actorOf, authGuard } from '../auth/auth.js';
import type { AppConfig } from '../config.js';
import { claimTask, deliverTask, listAvailableTasks, listRiderTasks, pickUpTask } from './service.js';

const TaskIdParams = Type.Object({ taskId: Type.String({ format: 'uuid' }) });
const Pagination = Type.Object({
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, default: 20 })),
  offset: Type.Optional(Type.Integer({ minimum: 0, default: 0 })),
});

export async function registerDeliveryRoutes(app: FastifyInstance, prisma: PrismaClient, config: AppConfig) {
  const rider = authGuard(prisma, config, ['RIDER']);

  app.get<{ Querystring: { limit?: number; offset?: number } }>('/delivery-tasks/available', {
    preHandler: rider,
    schema: { tags: ['delivery'], querystring: Pagination },
  }, async (request) => listAvailableTasks(prisma, request.query.limit ?? 20, request.query.offset ?? 0));

  app.get<{ Querystring: { limit?: number; offset?: number } }>('/delivery-tasks/mine', {
    preHandler: rider,
    schema: { tags: ['delivery'], querystring: Pagination },
  }, async (request) => listRiderTasks(prisma, actorOf(request), request.query.limit ?? 20, request.query.offset ?? 0));

  app.post<{ Params: { taskId: string } }>('/delivery-tasks/:taskId/claim', {
    preHandler: rider,
    schema: { tags: ['delivery'], params: TaskIdParams },
  }, async (request) => claimTask(prisma, actorOf(request), request.params.taskId));

  app.post<{ Params: { taskId: string } }>('/delivery-tasks/:taskId/pick-up', {
    preHandler: rider,
    schema: { tags: ['delivery'], params: TaskIdParams },
  }, async (request) => pickUpTask(prisma, actorOf(request), request.params.taskId));

  app.post<{ Params: { taskId: string } }>('/delivery-tasks/:taskId/deliver', {
    preHandler: rider,
    schema: { tags: ['delivery'], params: TaskIdParams },
  }, async (request) => deliverTask(prisma, actorOf(request), request.params.taskId));
}

