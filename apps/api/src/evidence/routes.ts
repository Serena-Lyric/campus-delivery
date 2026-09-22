import { EvidenceType, type PrismaClient } from '@prisma/client';
import { Type } from '@sinclair/typebox';
import type { FastifyInstance } from 'fastify';
import { actorOf, authGuard } from '../auth/auth.js';
import type { AppConfig } from '../config.js';
import type { MediaStorage } from './media-storage.js';
import { createEvidence } from './service.js';

const OrderIdParams = Type.Object({ orderId: Type.String({ format: 'uuid' }) });

export async function registerEvidenceRoutes(
  app: FastifyInstance,
  prisma: PrismaClient,
  config: AppConfig,
  storage: MediaStorage,
) {
  const authenticated = authGuard(prisma, config);
  app.post<{
    Params: { orderId: string };
    Body: {
      evidenceType: EvidenceType;
      media: { fileName: string; contentType: string; capturedAt?: string; source?: 'CAMERA' | 'UNKNOWN' };
      note?: string;
      metadata?: Record<string, unknown>;
    };
  }>('/orders/:orderId/evidence', {
    preHandler: authenticated,
    schema: {
      tags: ['evidence'],
      params: OrderIdParams,
      body: Type.Object({
        evidenceType: Type.Enum(EvidenceType),
        media: Type.Object({
          fileName: Type.String({ minLength: 1, maxLength: 200 }),
          contentType: Type.String({ minLength: 1, maxLength: 100 }),
          capturedAt: Type.Optional(Type.String({ format: 'date-time' })),
          source: Type.Optional(Type.Union([Type.Literal('CAMERA'), Type.Literal('UNKNOWN')])),
        }),
        note: Type.Optional(Type.String({ maxLength: 500 })),
        metadata: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
      }),
    },
  }, async (request, reply) => reply.status(201).send(await createEvidence(
    prisma,
    storage,
    actorOf(request),
    request.params.orderId,
    request.body,
  )));
}
