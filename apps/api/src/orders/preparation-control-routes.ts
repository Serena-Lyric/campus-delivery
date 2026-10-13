import type { PrismaClient } from '@prisma/client';
import { Type } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import type { FastifyInstance } from 'fastify';
import { actorOf, authGuard, adminGuard } from '../auth/auth.js';
import type { AppConfig } from '../config.js';
import { badRequest, notFound } from '../shared/errors.js';
import { applyPreparationAction, getPreparationControl, preparationActionSchemas, preparationUuid, PreparationControlView, type PreparationActionInput } from './preparation-control.js';
import { PreparationExitBody, PreparationExitReviewBody, requestPreparationExit, reviewPreparationExit, type ExitInput, type ExitReviewInput } from './preparation-exit.js';
import { PreparationReviewBody, reviewPreparationControl, type PreparationReviewInput } from './preparation-review.js';

export async function registerPreparationControlRoutes(app: FastifyInstance, prisma: PrismaClient, config: AppConfig) {
  const params = Type.Object({ orderId: preparationUuid() });
  app.post<{ Params: { orderId: string }; Body: PreparationReviewInput }>('/admin/orders/:orderId/preparation-review', {
    preHandler: adminGuard(prisma, config), preValidation: async (request) => { if (!Value.Check(PreparationReviewBody, request.body)) throw badRequest('INVALID_PREPARATION_REVIEW', 'Invalid fields'); },
    schema: { tags: ['preparation'], params, body: PreparationReviewBody, response: { 200: PreparationControlView },
      description: 'Current lawful case handler reviews recovery facts. No termination/refund; a current rider must explicitly respond; original deadline remains unchanged.' },
  }, async (request) => reviewPreparationControl(prisma, actorOf(request), request.params.orderId, request.body));
  app.post<{ Params: { taskId: string }; Body: ExitInput }>('/delivery-tasks/:taskId/request-preparation-exit', {
    preHandler: authGuard(prisma, config, ['RIDER']), preValidation: async (request) => { if (!Value.Check(PreparationExitBody, request.body)) throw badRequest('INVALID_EXIT_REQUEST', 'Invalid fields'); },
    schema: { tags: ['preparation'], params: Type.Object({ taskId: preparationUuid() }), body: PreparationExitBody,
      description: 'Request human-reviewed exit. Temporarily frees personal capacity only; does not release the assignment or its global hard-limit occupation.' },
  }, async (request) => requestPreparationExit(prisma, actorOf(request), request.params.taskId, request.body));
  app.post<{ Params: { orderId: string }; Body: ExitReviewInput }>('/admin/orders/:orderId/preparation-exit-review', {
    preHandler: adminGuard(prisma, config), preValidation: async (request) => { if (!Value.Check(PreparationExitReviewBody, request.body)) throw badRequest('INVALID_EXIT_REVIEW', 'Invalid fields'); },
    schema: { tags: ['preparation'], params, body: PreparationExitReviewBody,
      description: 'Only the current lawful handler may approve/reject pending exit. No payment/termination or automatic re-entry into the pool.' },
  }, async (request) => reviewPreparationExit(prisma, actorOf(request), request.params.orderId, request.body));
  for (const [path, action] of [['unable', 'DECLARE_UNABLE'], ['recover', 'REQUEST_RECOVERY']] as const) {
    app.post<{ Params: { orderId: string }; Body: PreparationActionInput }>(`/merchant/orders/:orderId/preparation/${path}`, {
      preHandler: authGuard(prisma, config, ['MERCHANT']), preValidation: async (request) => { if (!Value.Check(preparationActionSchemas[action], request.body)) throw badRequest('INVALID_PREPARATION_ACTION', 'Invalid fields'); },
      schema: { tags: ['preparation'], params, body: preparationActionSchemas[action], response: { 200: PreparationControlView } },
    }, async (request) => applyPreparationAction(prisma, actorOf(request), request.params.orderId, action, request.body));
  }
  app.get<{ Params: { orderId: string } }>('/orders/:orderId/preparation-control', {
    preHandler: authGuard(prisma, config), schema: { tags: ['preparation'], params, response: { 200: PreparationControlView } },
  }, async (request) => getPreparationControl(prisma, actorOf(request), request.params.orderId));
  app.post<{ Params: { orderId: string }; Body: PreparationActionInput }>('/orders/:orderId/preparation-escalate', {
    preHandler: authGuard(prisma, config), preValidation: async (request) => { if (!Value.Check(preparationActionSchemas.ESCALATE, request.body)) throw badRequest('INVALID_PREPARATION_ACTION', 'Invalid fields'); },
    schema: { tags: ['preparation'], params, body: preparationActionSchemas.ESCALATE, response: { 200: PreparationControlView } },
  }, async (request) => applyPreparationAction(prisma, actorOf(request), request.params.orderId, 'ESCALATE', request.body));
  app.post<{ Params: { taskId: string }; Body: PreparationActionInput }>('/delivery-tasks/:taskId/preparation-recovery-response', {
    preHandler: authGuard(prisma, config, ['RIDER']), preValidation: async (request) => { if (!Value.Check(preparationActionSchemas.RESPOND_RECOVERY, request.body)) throw badRequest('INVALID_PREPARATION_ACTION', 'Invalid fields'); },
    schema: { tags: ['preparation'], params: Type.Object({ taskId: preparationUuid() }), body: preparationActionSchemas.RESPOND_RECOVERY, response: { 200: PreparationControlView } },
  }, async (request) => {
    const task = await prisma.deliveryTask.findUnique({ where: { id: request.params.taskId }, select: { orderId: true } });
    if (!task) throw notFound('Delivery task');
    return applyPreparationAction(prisma, actorOf(request), task.orderId, 'RESPOND_RECOVERY', request.body);
  });
}
