import type { PrismaClient } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import { Type } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { actorOf, authGuard, adminGuard } from '../auth/auth.js';
import type { AppConfig } from '../config.js';
import { badRequest } from '../shared/errors.js';
import { preparationUuid } from './preparation-control.js';
import { ChangeNoticeBody, GoodsReviewBody, appendChangeNotice, getChangeNotices, acknowledgeChangeNotice, reviewGoodsChange, type NoticeInput, type GoodsReviewInput } from './order-change.js';

export async function registerOrderChangeRoutes(app: FastifyInstance, prisma: PrismaClient, config: AppConfig) {
  const params = Type.Object({ orderId: preparationUuid() });
  const check = (schema: typeof ChangeNoticeBody | typeof GoodsReviewBody) => async (request: { body: unknown }) => {
    if (!Value.Check(schema, request.body)) throw badRequest('INVALID_GOODS_CHANGE_ACTION', 'Invalid fields');
  };
  app.post<{ Params: { orderId: string }; Body: NoticeInput }>('/merchant/orders/:orderId/change-notices', {
    preHandler: authGuard(prisma, config, ['MERCHANT']), preValidation: check(ChangeNoticeBody),
    schema: { tags: ['order-changes'], params, body: ChangeNoticeBody, description: 'Append a self-reported notice. Extra or unassessed core risk requires human review. Does not approve substitution or change original prices/risk.' },
  }, async (request, reply) => reply.status(201).send(await appendChangeNotice(prisma, actorOf(request), request.params.orderId, request.body)));
  app.get<{ Params: { orderId: string } }>('/orders/:orderId/change-notices', {
    preHandler: authGuard(prisma, config), schema: { tags: ['order-changes'], params },
  }, async (request) => getChangeNotices(prisma, actorOf(request), request.params.orderId));
  app.post<{ Params: { taskId: string; noticeId: string }; Body: { assignmentId: string } }>('/delivery-tasks/:taskId/change-notices/:noticeId/acknowledge', {
    preHandler: authGuard(prisma, config, ['RIDER']), schema: { tags: ['order-changes'], params: Type.Object({ taskId: preparationUuid(), noticeId: preparationUuid() }),
      body: Type.Object({ assignmentId: preparationUuid() }, { additionalProperties: false }), description: 'Voluntary read receipt. Not acceptance, waiver, evidence or a pickup prerequisite.' },
  }, async (request) => acknowledgeChangeNotice(prisma, actorOf(request), request.params.taskId, request.params.noticeId, request.body.assignmentId));
  app.post<{ Params: { orderId: string }; Body: GoodsReviewInput }>('/admin/orders/:orderId/goods-change-review', {
    preHandler: adminGuard(prisma, config), preValidation: check(GoodsReviewBody), schema: { tags: ['order-changes'], params, body: GoodsReviewBody,
      description: 'Current lawful handler records risk facts. Actual added/unknown core risk or value remains on hold. No pricing, substitution approval or termination.' },
  }, async (request) => reviewGoodsChange(prisma, actorOf(request), request.params.orderId, request.body));
}
