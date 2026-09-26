import type { Prisma, PrismaClient } from '@prisma/client';
import { Type } from '@sinclair/typebox';
import type { FastifyInstance } from 'fastify';
import { actorOf, adminGuard } from '../auth/auth.js';
import type { AppConfig } from '../config.js';
import { getBusinessConfig, updateBusinessConfig } from './config-service.js';

const KeyParams = Type.Object({ key: Type.String({ minLength: 1, maxLength: 100 }) });

export async function registerAdminConfigRoutes(app: FastifyInstance, prisma: PrismaClient, config: AppConfig) {
  const admin = adminGuard(prisma, config, ['SUPER_ADMIN']);

  app.get<{ Params: { key: string } }>('/admin/business-configs/:key', {
    preHandler: admin,
    schema: { tags: ['admin-config'], params: KeyParams },
  }, async (request) => getBusinessConfig(prisma, actorOf(request), request.params.key));

  app.put<{
    Params: { key: string };
    Body: { payload: Record<string, unknown>; reason: string };
  }>('/admin/business-configs/:key', {
    preHandler: admin,
    schema: {
      tags: ['admin-config'],
      params: KeyParams,
      body: Type.Object({
        payload: Type.Record(Type.String(), Type.Unknown()),
        reason: Type.String({ minLength: 1, maxLength: 500 }),
      }),
    },
  }, async (request) => updateBusinessConfig(
    prisma,
    actorOf(request),
    request.params.key,
    request.body.payload as Prisma.InputJsonValue,
    request.body.reason,
  ));
}
