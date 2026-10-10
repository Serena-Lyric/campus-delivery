import type { PrismaClient } from '@prisma/client';
import { Type } from '@sinclair/typebox';
import type { FastifyInstance } from 'fastify';
import { actorOf, adminGuard } from '../auth/auth.js';
import type { AppConfig } from '../config.js';
import { getOperatingBudgetPreview, getOrderFinanceProjection } from './service.js';
import { BudgetScenarioSchema, type BudgetScenario } from './reserve.js';
import { Value } from '@sinclair/typebox/value';
import { badRequest } from '../shared/errors.js';

export async function registerFinanceRoutes(app: FastifyInstance, prisma: PrismaClient, config: AppConfig) {
  app.post<{ Body: BudgetScenario }>('/admin/finance/budget-preview', {
    preHandler: adminGuard(prisma, config, ['SUPER_ADMIN']),
    preValidation: async (request) => {
      if (!Value.Check(BudgetScenarioSchema, request.body)) throw badRequest('INVALID_BUDGET_SCENARIO', 'Only simulated inputs accepted; verified cash and Root authorization cannot be client-supplied');
    },
    schema: { tags: ['finance'], description: 'Read-only hypothetical budget simulation. No balance, salary reservation, approval or payment is written. Real withdrawals always disabled.', body: BudgetScenarioSchema },
  }, async (request) => getOperatingBudgetPreview(prisma, actorOf(request), request.body));
  app.get<{ Params: { orderId: string } }>('/admin/finance/orders/:orderId/projection', {
    preHandler: adminGuard(prisma, config, ['SUPER_ADMIN']),
    schema: { tags: ['finance'], description: 'Read-only development accounting projection. Estimates are platform costs, never verified fees or withdrawable cash.',
      params: Type.Object({ orderId: Type.String({ format: 'uuid' }) }) },
  }, async (request) => getOrderFinanceProjection(prisma, actorOf(request), request.params.orderId));
}
