import { RiderCancellationReason, type PrismaClient } from '@prisma/client';
import { Type } from '@sinclair/typebox';
import type { FastifyInstance } from 'fastify';
import { actorOf, adminGuard, authGuard } from '../auth/auth.js';
import type { AppConfig } from '../config.js';
import {
  cancelBeforePickup,
  createManualRestriction,
  getMyRiderRestrictions,
  getRiderRestrictionAdminView,
  overrideRiderRestriction,
} from './restrictions.js';

const TaskParams = Type.Object({ taskId: Type.String({ format: 'uuid' }) });
const RiderParams = Type.Object({ riderId: Type.String({ format: 'uuid' }) });
const RestrictionParams = Type.Object({ restrictionId: Type.String({ format: 'uuid' }) });

export async function registerRiderRoutes(app: FastifyInstance, prisma: PrismaClient, config: AppConfig) {
  const rider = authGuard(prisma, config, ['RIDER']);
  const superAdmin = adminGuard(prisma, config, ['SUPER_ADMIN']);

  app.post<{
    Params: { taskId: string };
    Body: { reason: RiderCancellationReason; note?: string };
  }>('/delivery-tasks/:taskId/pre-pickup-cancel', {
    preHandler: rider,
    schema: {
      tags: ['rider-exceptions'],
      params: TaskParams,
      body: Type.Object({
        reason: Type.Enum(RiderCancellationReason),
        note: Type.Optional(Type.String({ minLength: 1, maxLength: 500 })),
      }),
    },
  }, async (request) => cancelBeforePickup(prisma, actorOf(request), request.params.taskId, request.body, config));

  app.get('/riders/me/restrictions', {
    preHandler: rider,
    schema: { tags: ['rider-exceptions'] },
  }, async (request) => getMyRiderRestrictions(prisma, actorOf(request), config));

  app.post<{
    Params: { riderId: string };
    Body: { endsAt: string; reason: string };
  }>('/admin/riders/:riderId/restrictions', {
    preHandler: superAdmin,
    schema: {
      tags: ['admin-rider-restrictions'],
      params: RiderParams,
      body: Type.Object({
        endsAt: Type.String({ format: 'date-time' }),
        reason: Type.String({ minLength: 1, maxLength: 500 }),
      }),
    },
  }, async (request, reply) => reply.status(201).send(await createManualRestriction(
    prisma,
    actorOf(request),
    request.params.riderId,
    new Date(request.body.endsAt),
    request.body.reason,
  )));

  app.get<{ Params: { riderId: string } }>('/admin/riders/:riderId/restrictions', {
    preHandler: superAdmin,
    schema: { tags: ['admin-rider-restrictions'], params: RiderParams },
  }, async (request) => getRiderRestrictionAdminView(prisma, actorOf(request), request.params.riderId, config));

  app.patch<{
    Params: { restrictionId: string };
    Body: { action: 'RELEASE' | 'EXTEND'; endsAt?: string; reason: string };
  }>('/admin/rider-restrictions/:restrictionId', {
    preHandler: superAdmin,
    schema: {
      tags: ['admin-rider-restrictions'],
      params: RestrictionParams,
      body: Type.Object({
        action: Type.Union([Type.Literal('RELEASE'), Type.Literal('EXTEND')]),
        endsAt: Type.Optional(Type.String({ format: 'date-time' })),
        reason: Type.String({ minLength: 1, maxLength: 500 }),
      }),
    },
  }, async (request) => overrideRiderRestriction(prisma, actorOf(request), request.params.restrictionId, {
    action: request.body.action,
    ...(request.body.endsAt ? { endsAt: new Date(request.body.endsAt) } : {}),
    reason: request.body.reason,
  }));
}
