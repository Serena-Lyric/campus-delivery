import type { PrismaClient } from '@prisma/client';
import { Type } from '@sinclair/typebox';
import type { FastifyInstance } from 'fastify';
import { actorOf, authGuard } from '../auth/auth.js';
import { reportCatalogRisk, type CatalogRiskInput } from '../catalog/risk-correction.js';
import type { AppConfig } from '../config.js';
import {
  claimTask,
  deliverTask,
  listAvailableTasks,
  listRiderTasks,
  pickUpTask,
  reportPickupEvidenceUnavailable,
} from './service.js';

const TaskIdParams = Type.Object({ taskId: Type.String({ format: 'uuid' }) });
const Pagination = Type.Object({
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, default: 20 })),
  offset: Type.Optional(Type.Integer({ minimum: 0, default: 0 })),
});
const EvidenceBody = Type.Object({ evidenceId: Type.Optional(Type.String({ format: 'uuid' })), pickupPhotoEvidenceId: Type.Optional(Type.String({ format: 'uuid' })) });
const DeliverBody = Type.Object({
  evidenceId: Type.Optional(Type.String({ format: 'uuid' })),
  code: Type.Optional(Type.String({ pattern: '^[0-9]{6}$' })),
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
  }, async (request) => claimTask(prisma, actorOf(request), request.params.taskId, undefined, config.campusTimeZone));

  app.post<{ Params: { taskId: string }; Body: { evidenceId?: string; pickupPhotoEvidenceId?: string } }>('/delivery-tasks/:taskId/pick-up', {
    preHandler: rider,
    schema: { tags: ['delivery'], params: TaskIdParams, body: EvidenceBody },
  }, async (request) => pickUpTask(prisma, actorOf(request), request.params.taskId, request.body.evidenceId, request.body.pickupPhotoEvidenceId));

  app.post<{ Params: { taskId: string }; Body: CatalogRiskInput }>('/delivery-tasks/:taskId/report-catalog-risk', {
    preHandler: rider,
    schema: { tags: ['delivery'], params: TaskIdParams, body: Type.Object({
      assignmentId: Type.String({ format: 'uuid' }), orderItemId: Type.String({ format: 'uuid' }),
      observedCategoryCode: Type.Union([Type.Literal('CAKE'), Type.Literal('SUNDAE')]),
      reason: Type.String({ minLength: 1, maxLength: 500, pattern: '\\S' }),
      evidenceIds: Type.Optional(Type.Array(Type.String({ format: 'uuid' }), { maxItems: 10, uniqueItems: true })),
    }, { additionalProperties: false }) },
  }, async (request) => reportCatalogRisk(prisma, actorOf(request), request.params.taskId, request.body));

  app.post<{ Params: { taskId: string }; Body: { reason: string } }>('/delivery-tasks/:taskId/pickup-evidence-unavailable', {
    preHandler: rider,
    schema: { tags: ['delivery'], params: TaskIdParams, body: Type.Object({ reason: Type.String({ minLength: 1, maxLength: 500, pattern: '\\S' }) }) },
  }, async (request) => reportPickupEvidenceUnavailable(prisma, actorOf(request), request.params.taskId, request.body.reason));

  app.post<{ Params: { taskId: string }; Body: { evidenceId?: string; code?: string } }>('/delivery-tasks/:taskId/deliver', {
    preHandler: rider,
    schema: { tags: ['delivery'], params: TaskIdParams, body: DeliverBody },
  }, async (request) => deliverTask(prisma, actorOf(request), request.params.taskId, request.body, undefined, config.campusTimeZone));
}
