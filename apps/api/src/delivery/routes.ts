import type { PrismaClient } from '@prisma/client';
import { Type } from '@sinclair/typebox';
import type { FastifyInstance } from 'fastify';
import { actorOf, authGuard, adminGuard } from '../auth/auth.js';
import { issueRiderPickupCode } from './pickup-code.js';
import { confirmRiderPickup, type MerchantPickupInput } from './merchant-pickup.js';
import { disputePickup, acknowledgePickupMistake, resolvePickupDispute, type PickupDisputeInput, type ResolvePickupInput } from './pickup-dispute.js';
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
  const merchant = authGuard(prisma, config, ['MERCHANT']);
  const admin = adminGuard(prisma, config);
  const uuid = () => Type.String({ format: 'uuid' });
  const note = () => Type.String({ minLength: 1, maxLength: 500, pattern: '\\S' });
  const orderParams = Type.Object({ orderId: uuid() });

  app.post<{ Params: { taskId: string }; Body: { assignmentId: string } }>('/delivery-tasks/:taskId/pickup-code', {
    preHandler: rider, schema: { tags: ['pickup-protocol'], params: TaskIdParams, body: Type.Object({ assignmentId: uuid() }, { additionalProperties: false }) },
  }, async (request, reply) => reply.status(201).send(await issueRiderPickupCode(prisma, actorOf(request), request.params.taskId, request.body.assignmentId)));

  app.post<{ Params: { orderId: string }; Body: MerchantPickupInput }>('/merchant/orders/:orderId/confirm-rider-pickup', {
    preHandler: merchant, schema: { tags: ['pickup-protocol'], params: orderParams, body: Type.Object({ assignmentId: uuid(), expectedRevision: Type.Integer({ minimum: 0 }), requestKey: uuid(), photoEvidenceId: Type.Optional(uuid()), codeId: Type.Optional(uuid()), code: Type.Optional(Type.String({ pattern: '^[0-9]{6}$' })) }, { additionalProperties: false }) },
  }, async (request) => confirmRiderPickup(prisma, actorOf(request), request.params.orderId, request.body));

  app.post<{ Params: { taskId: string }; Body: PickupDisputeInput }>('/delivery-tasks/:taskId/dispute-pickup', {
    preHandler: rider, schema: { tags: ['pickup-protocol'], params: TaskIdParams, body: Type.Object({ assignmentId: uuid(), handoffId: uuid(), reason: note(), evidenceIds: Type.Optional(Type.Array(uuid(), { maxItems: 10, uniqueItems: true })), catalogRiskClaim: Type.Optional(Type.Object({ orderItemId: uuid(), observedCategoryCode: Type.Union([Type.Literal('CAKE'), Type.Literal('SUNDAE')]) }, { additionalProperties: false })) }, { additionalProperties: false }) },
  }, async (request) => disputePickup(prisma, actorOf(request), request.params.taskId, request.body));

  app.post<{ Params: { orderId: string }; Body: { disputeId: string; expectedVersion: number; note: string } }>('/merchant/orders/:orderId/acknowledge-pickup-mistake', {
    preHandler: merchant, schema: { tags: ['pickup-protocol'], params: orderParams, body: Type.Object({ disputeId: uuid(), expectedVersion: Type.Integer({ minimum: 0 }), note: note() }, { additionalProperties: false }) },
  }, async (request) => acknowledgePickupMistake(prisma, actorOf(request), request.params.orderId, request.body.disputeId, request.body.expectedVersion, request.body.note));

  app.post<{ Params: { disputeId: string }; Body: ResolvePickupInput }>('/admin/pickup-disputes/:disputeId/resolve', {
    preHandler: admin, schema: { tags: ['pickup-protocol'], params: Type.Object({ disputeId: uuid() }), body: Type.Object({ expectedVersion: Type.Integer({ minimum: 0 }), expectedCaseVersion: Type.Integer({ minimum: 0 }), requestKey: uuid(), outcome: Type.Union([Type.Literal('NOT_HANDED_OVER'), Type.Literal('HANDED_OVER'), Type.Literal('INCONCLUSIVE')]), note: note() }, { additionalProperties: false }) },
  }, async (request) => resolvePickupDispute(prisma, actorOf(request), request.params.disputeId, request.body));

  app.get<{ Querystring: { limit?: number; offset?: number } }>('/delivery-tasks/available', {
    preHandler: rider,
    schema: { tags: ['delivery'], querystring: Pagination },
  }, async (request) => listAvailableTasks(prisma, actorOf(request), request.query.limit ?? 20, request.query.offset ?? 0, config.campusTimeZone));

  app.get<{ Querystring: { limit?: number; offset?: number } }>('/delivery-tasks/mine', {
    preHandler: rider,
    schema: { tags: ['delivery'], querystring: Pagination },
  }, async (request) => listRiderTasks(prisma, actorOf(request), request.query.limit ?? 20, request.query.offset ?? 0, config.campusTimeZone));

  app.post<{ Params: { taskId: string } }>('/delivery-tasks/:taskId/claim', {
    preHandler: rider,
    schema: { tags: ['delivery'], params: TaskIdParams },
  }, async (request) => claimTask(prisma, actorOf(request), request.params.taskId, undefined, config.campusTimeZone));

  app.post<{ Params: { taskId: string }; Body: { evidenceId?: string; pickupPhotoEvidenceId?: string } }>('/delivery-tasks/:taskId/pick-up', {
    preHandler: rider,
    schema: { tags: ['delivery'], params: TaskIdParams, body: EvidenceBody, deprecated: true },
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
