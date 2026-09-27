import {
  ExceptionCaseStatus,
  ExceptionResolutionType,
  ExceptionType,
  type PrismaClient,
} from '@prisma/client';
import { Type } from '@sinclair/typebox';
import type { FastifyInstance } from 'fastify';
import { actorOf, adminGuard, authGuard } from '../auth/auth.js';
import { getRiderCompensationSummary, refundAndCloseExceptionCase, releaseCompensationReservations } from '../compensation/service.js';
import type { AppConfig } from '../config.js';
import {
  claimExceptionCase,
  escalateExceptionCase,
  getExceptionCaseForAdmin,
  listExceptionCases,
  releaseExceptionCase,
  resolveNonEconomicCase,
  takeoverExceptionCase,
  transferExceptionCase,
} from './service.js';
import {
  getOrderExceptionView,
  proposeRemake,
  reportSevereRiderException,
  respondToRemake,
} from '../exceptions/severe-service.js';
import { conflict } from '../shared/errors.js';

const CaseParams = Type.Object({ caseId: Type.String({ format: 'uuid' }) });
const OrderParams = Type.Object({ orderId: Type.String({ format: 'uuid' }) });
const VersionBody = Type.Object({ expectedVersion: Type.Integer({ minimum: 0 }) });
const PublicAdminResolutionType = Type.Exclude(
  Type.Enum(ExceptionResolutionType),
  Type.Union([
    Type.Literal(ExceptionResolutionType.REMAKE_AND_CONTINUE),
    Type.Literal(ExceptionResolutionType.ESCALATED_OTHER),
  ]),
);

export async function registerExceptionCaseRoutes(app: FastifyInstance, prisma: PrismaClient, config: AppConfig) {
  const admin = adminGuard(prisma, config);
  const superAdmin = adminGuard(prisma, config, ['SUPER_ADMIN']);
  const rider = authGuard(prisma, config, ['RIDER']);
  const customer = authGuard(prisma, config, ['CUSTOMER']);
  const authenticated = authGuard(prisma, config);

  app.get<{ Querystring: { status?: ExceptionCaseStatus } }>('/admin/exception-cases', {
    preHandler: admin,
    schema: {
      tags: ['exception-cases'],
      querystring: Type.Object({ status: Type.Optional(Type.Enum(ExceptionCaseStatus)) }),
    },
  }, async (request) => listExceptionCases(prisma, actorOf(request), request.query.status));

  app.get<{ Params: { caseId: string } }>('/admin/exception-cases/:caseId', {
    preHandler: admin,
    schema: { tags: ['exception-cases'], params: CaseParams },
  }, async (request) => getExceptionCaseForAdmin(prisma, actorOf(request), request.params.caseId));

  app.post<{ Params: { caseId: string }; Body: { expectedVersion: number } }>('/admin/exception-cases/:caseId/claim', {
    preHandler: admin,
    schema: { tags: ['exception-cases'], params: CaseParams, body: VersionBody },
  }, async (request) => claimExceptionCase(prisma, actorOf(request), request.params.caseId, request.body.expectedVersion));

  app.post<{ Params: { caseId: string }; Body: { expectedVersion: number; reason: string } }>('/admin/exception-cases/:caseId/release', {
    preHandler: admin,
    schema: {
      tags: ['exception-cases'], params: CaseParams,
      body: Type.Intersect([VersionBody, Type.Object({ reason: Type.String({ minLength: 1, maxLength: 500 }) })]),
    },
  }, async (request) => releaseExceptionCase(prisma, actorOf(request), request.params.caseId, request.body.expectedVersion, request.body.reason));

  app.post<{ Params: { caseId: string }; Body: { expectedVersion: number; reason: string } }>('/admin/exception-cases/:caseId/escalate', {
    preHandler: admin,
    schema: {
      tags: ['exception-cases'], params: CaseParams,
      body: Type.Intersect([VersionBody, Type.Object({ reason: Type.String({ minLength: 1, maxLength: 500 }) })]),
    },
  }, async (request) => escalateExceptionCase(prisma, actorOf(request), request.params.caseId, request.body.expectedVersion, request.body.reason));

  app.post<{
    Params: { caseId: string };
    Body: { expectedVersion: number; nextHandlerAdminId: string; reason: string };
  }>('/admin/exception-cases/:caseId/takeover', {
    preHandler: superAdmin,
    schema: {
      tags: ['exception-cases'], params: CaseParams,
      body: Type.Intersect([VersionBody, Type.Object({
        nextHandlerAdminId: Type.String({ format: 'uuid' }),
        reason: Type.String({ minLength: 1, maxLength: 500 }),
      })]),
    },
  }, async (request) => takeoverExceptionCase(
    prisma,
    actorOf(request),
    request.params.caseId,
    request.body.expectedVersion,
    request.body.nextHandlerAdminId,
    request.body.reason,
  ));

  app.post<{
    Params: { caseId: string };
    Body: { expectedVersion: number; nextHandlerAdminId: string; reason: string };
  }>('/admin/exception-cases/:caseId/transfer', {
    preHandler: admin,
    schema: {
      tags: ['exception-cases'], params: CaseParams,
      body: Type.Intersect([VersionBody, Type.Object({
        nextHandlerAdminId: Type.String({ format: 'uuid' }),
        reason: Type.String({ minLength: 1, maxLength: 500 }),
      })]),
    },
  }, async (request) => transferExceptionCase(
    prisma,
    actorOf(request),
    request.params.caseId,
    request.body.expectedVersion,
    request.body.nextHandlerAdminId,
    request.body.reason,
  ));

  app.post<{
    Params: { caseId: string };
    Body: { expectedVersion: number; resolutionType: ExceptionResolutionType; note: string; idempotencyKey?: string };
  }>('/admin/exception-cases/:caseId/resolve', {
    preHandler: admin,
    schema: {
      tags: ['exception-cases'], params: CaseParams,
      body: Type.Object({
        expectedVersion: Type.Integer({ minimum: 0 }),
        resolutionType: PublicAdminResolutionType,
        note: Type.String({ minLength: 1, maxLength: 1000 }),
        idempotencyKey: Type.Optional(Type.String({ minLength: 8, maxLength: 200 })),
      }),
    },
  }, async (request) => {
    if (request.body.resolutionType === ExceptionResolutionType.REFUND_AND_CLOSE) {
      return refundAndCloseExceptionCase(prisma, actorOf(request), request.params.caseId, {
        expectedVersion: request.body.expectedVersion,
        idempotencyKey: request.body.idempotencyKey ?? `case:${request.params.caseId}:refund`,
        reason: request.body.note,
      });
    }
    if (request.body.resolutionType === ExceptionResolutionType.REMAKE_AND_CONTINUE) {
      throw conflict('CUSTOMER_CONFIRMATION_REQUIRED', 'REMAKE_AND_CONTINUE requires customer confirmation');
    }
    if (request.body.resolutionType === ExceptionResolutionType.ESCALATED_OTHER) {
      throw conflict('USE_ESCALATION_ACTION', 'Escalation must use the audited escalate action');
    }
    return resolveNonEconomicCase(
      prisma,
      actorOf(request),
      request.params.caseId,
      request.body.expectedVersion,
      request.body.resolutionType,
      request.body.note,
    );
  });

  app.post<{
    Params: { orderId: string };
    Body: { type: ExceptionType; description: string };
  }>('/rider/orders/:orderId/severe-exception', {
    preHandler: rider,
    schema: {
      tags: ['rider-exceptions'], params: OrderParams,
      body: Type.Object({
        type: Type.Union([Type.Literal(ExceptionType.SEVERE_FOOD_DAMAGE), Type.Literal(ExceptionType.FOOD_LOST)]),
        description: Type.String({ minLength: 1, maxLength: 1000 }),
      }),
    },
  }, async (request, reply) => reply.status(201).send(await reportSevereRiderException(prisma, actorOf(request), request.params.orderId, request.body)));

  app.post<{ Params: { caseId: string }; Body: { message: string } }>('/exception-cases/:caseId/remake-proposal', {
    preHandler: rider,
    schema: {
      tags: ['rider-exceptions'], params: CaseParams,
      body: Type.Object({ message: Type.String({ minLength: 1, maxLength: 1000 }) }),
    },
  }, async (request, reply) => reply.status(201).send(await proposeRemake(prisma, actorOf(request), request.params.caseId, request.body.message)));

  app.post<{ Params: { caseId: string }; Body: { accept: boolean } }>('/exception-cases/:caseId/remake-response', {
    preHandler: customer,
    schema: { tags: ['customer-exceptions'], params: CaseParams, body: Type.Object({ accept: Type.Boolean() }) },
  }, async (request) => respondToRemake(prisma, actorOf(request), request.params.caseId, request.body.accept));

  app.post<{
    Params: { caseId: string };
    Body: { expectedVersion: number; idempotencyKey: string; voluntaryPaymentMinor?: number; reason: string };
  }>('/exception-cases/:caseId/voluntary-compensation', {
    preHandler: rider,
    schema: {
      tags: ['rider-exceptions'], params: CaseParams,
      body: Type.Object({
        expectedVersion: Type.Integer({ minimum: 0 }),
        idempotencyKey: Type.String({ minLength: 8, maxLength: 200 }),
        voluntaryPaymentMinor: Type.Optional(Type.Integer({
          minimum: 0,
          description: 'Temporarily restricted to 0 until a verifiable rider payment source is available',
        })),
        reason: Type.String({ minLength: 1, maxLength: 500 }),
      }),
    },
  }, async (request, reply) => reply.status(201).send(await refundAndCloseExceptionCase(
    prisma,
    actorOf(request),
    request.params.caseId,
    request.body,
  )));

  app.get('/riders/me/compensations', {
    preHandler: rider,
    schema: { tags: ['rider-exceptions'] },
  }, async (request) => getRiderCompensationSummary(prisma, actorOf(request)));

  app.post<{
    Params: { caseId: string };
    Body: { expectedVersion: number; idempotencyKey: string; reason: string };
  }>('/admin/exception-cases/:caseId/release-compensation', {
    preHandler: admin,
    schema: {
      tags: ['exception-cases'], params: CaseParams,
      body: Type.Object({
        expectedVersion: Type.Integer({ minimum: 0 }),
        idempotencyKey: Type.String({ minLength: 8, maxLength: 200 }),
        reason: Type.String({ minLength: 1, maxLength: 500 }),
      }),
    },
  }, async (request) => releaseCompensationReservations(
    prisma,
    actorOf(request),
    request.params.caseId,
    request.body.expectedVersion,
    request.body.idempotencyKey,
    request.body.reason,
  ));

  app.get<{ Params: { orderId: string } }>('/orders/:orderId/exception-cases', {
    preHandler: authenticated,
    schema: { tags: ['exceptions'], params: OrderParams },
  }, async (request) => getOrderExceptionView(prisma, actorOf(request), request.params.orderId));
}
