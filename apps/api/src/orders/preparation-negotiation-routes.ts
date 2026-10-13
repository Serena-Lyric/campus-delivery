import type { PrismaClient } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import { Type, type TSchema } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { actorOf, authGuard, adminGuard } from '../auth/auth.js';
import type { AppConfig } from '../config.js';
import { badRequest } from '../shared/errors.js';
import { preparationUuid } from './preparation-control.js';
import { NegotiationStatementBody, NegotiationReviewBody, recordNegotiationStatement, getPreparationNegotiation, reviewPreparationNegotiation, type StatementInput, type NegotiationReviewInput } from './preparation-negotiation.js';

export async function registerPreparationNegotiationRoutes(app: FastifyInstance, prisma: PrismaClient, config: AppConfig) {
  const params = Type.Object({ orderId: preparationUuid() });
  app.post<{ Params: { orderId: string }; Body: StatementInput }>('/orders/:orderId/preparation-negotiation/statements', {
    // Validate the discriminated union without AJV removing fields while trying a different branch.
    validatorCompiler: ({ schema }) => (data) => Value.Check(schema as TSchema, data)
      ? { value: data } : { error: badRequest('INVALID_NEGOTIATION_STATEMENT', 'Invalid fields') },
    preHandler: authGuard(prisma, config, ['CUSTOMER', 'MERCHANT']), preValidation: async (request) => { if (!Value.Check(NegotiationStatementBody, request.body)) throw badRequest('INVALID_NEGOTIATION_STATEMENT', 'Invalid fields'); },
    schema: { tags: ['preparation-negotiation'], params, body: NegotiationStatementBody, description: 'Append participant terms/confirmations/refund progress, each self-reported and separate from trusted refund success.' },
  }, async (request, reply) => reply.status(201).send(await recordNegotiationStatement(prisma, actorOf(request), request.params.orderId, request.body)));
  app.get<{ Params: { orderId: string } }>('/orders/:orderId/preparation-negotiation', {
    preHandler: authGuard(prisma, config), schema: { tags: ['preparation-negotiation'], params },
  }, async (request) => getPreparationNegotiation(prisma, actorOf(request), request.params.orderId));
  app.post<{ Params: { orderId: string }; Body: NegotiationReviewInput }>('/admin/orders/:orderId/preparation-negotiation-review', {
    preHandler: adminGuard(prisma, config), preValidation: async (request) => { if (!Value.Check(NegotiationReviewBody, request.body)) throw badRequest('INVALID_NEGOTIATION_REVIEW', 'Invalid fields'); },
    schema: { tags: ['preparation-negotiation'], params, body: NegotiationReviewBody, description: 'Current handler reviews one whole-order agreement. Waits for trusted funds facts or ordinary review; does not terminate, refund, approve money or create income.' },
  }, async (request) => reviewPreparationNegotiation(prisma, actorOf(request), request.params.orderId, request.body));
}
