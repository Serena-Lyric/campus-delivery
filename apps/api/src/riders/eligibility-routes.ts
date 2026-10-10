import type { PrismaClient } from '@prisma/client';
import { Type } from '@sinclair/typebox';
import type { FastifyInstance } from 'fastify';
import { actorOf, adminGuard, authGuard } from '../auth/auth.js';
import type { AppConfig } from '../config.js';
import { createAcademicTerm, getAdminEligibility, getMyEligibility, listAcademicTerms, reviewEligibility, submitRenewal, type RenewalInput, type ReviewInput } from './eligibility.js';
import type { TermInput } from './eligibility-policy.js';

export async function registerEligibilityRoutes(app: FastifyInstance, prisma: PrismaClient, config: AppConfig) {
  const rider = authGuard(prisma, config, ['RIDER']);
  // Temporary L1 execution bridge; SUPER_ADMIN is not a Root identity.
  const admin = adminGuard(prisma, config, ['SUPER_ADMIN']);
  const uuid = () => Type.String({ format: 'uuid' });
  const date = () => Type.String({ format: 'date-time' });
  const note = () => Type.String({ minLength: 1, maxLength: 500, pattern: '\\S' });
  const params = Type.Object({ riderId: uuid() });
  const tags = ['rider-eligibility'];
  app.get('/riders/me/eligibility', { preHandler: rider, schema: { tags } }, async (req) => getMyEligibility(prisma, actorOf(req)));
  app.post<{ Body: RenewalInput }>('/riders/me/renewal-requests', { preHandler: rider, schema: { tags,
    body: Type.Object({ termId: uuid(), intent: Type.Union([Type.Literal('CONTINUE'), Type.Literal('DECLINE'), Type.Literal('GRADUATE_EXCEPTION')]), requestKey: uuid() }, { additionalProperties: false }) } },
  async (req) => submitRenewal(prisma, actorOf(req), req.body));
  app.get('/admin/academic-terms', { preHandler: admin, schema: { tags } }, async (req) => listAcademicTerms(prisma, actorOf(req)));
  app.post<{ Body: TermInput }>('/admin/academic-terms', { preHandler: admin, schema: { tags,
    description: 'Explicit single-campus calendar; immutable terms, one renewal window, no inferred grace period.',
    body: Type.Object({ name: note(), timeZone: Type.String({ minLength: 1, maxLength: 100 }), startsAt: date(), endsAt: date(), renewalOpensAt: date(), renewalClosesAt: date(), reminderStartsAt: date(), requestKey: uuid(), reason: note() }, { additionalProperties: false }) } },
  async (req, reply) => reply.status(201).send(await createAcademicTerm(prisma, actorOf(req), req.body)));
  app.get<{ Params: { riderId: string } }>('/admin/riders/:riderId/eligibility', { preHandler: admin, schema: { tags, params } },
    async (req) => getAdminEligibility(prisma, actorOf(req), req.params.riderId));
  const base = { expectedVersion: Type.Integer({ minimum: 0 }), requestKey: uuid(), reason: note() };
  app.post<{ Params: { riderId: string }; Body: ReviewInput }>('/admin/riders/:riderId/eligibility/reviews', { preHandler: admin, schema: { tags, params,
    description: 'Administrator verified facts only; no graduate exception approval. Version and idempotency protected.',
    body: Type.Union([
      Type.Object({ ...base, action: Type.Literal('APPROVE'), termId: uuid(), validFrom: date(), validUntil: date() }, { additionalProperties: false }),
      Type.Object({ ...base, action: Type.Literal('REJECT'), termId: uuid() }, { additionalProperties: false }),
      Type.Object({ ...base, action: Type.Literal('SET_GRADUATION'), expectedGraduationAt: Type.Union([date(), Type.Null()]), graduationReminderAt: Type.Union([date(), Type.Null()]) }, { additionalProperties: false }),
    ]) } }, async (req) => reviewEligibility(prisma, actorOf(req), req.params.riderId, req.body));
}
