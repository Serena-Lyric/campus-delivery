import { AdminLevel, type PrismaClient } from '@prisma/client';
import { Type } from '@sinclair/typebox';
import type { FastifyInstance } from 'fastify';
import { actorOf, adminGuard } from '../auth/auth.js';
import type { AppConfig } from '../config.js';
import { setAdminLevel } from './profiles.js';

export async function registerAdminProfileRoutes(app: FastifyInstance, prisma: PrismaClient, config: AppConfig) {
  const superAdmin = adminGuard(prisma, config, [AdminLevel.SUPER_ADMIN]);
  app.put<{
    Params: { userId: string };
    Body: { level: AdminLevel; reason: string };
  }>('/admin/users/:userId/admin-profile', {
    preHandler: superAdmin,
    schema: {
      tags: ['admin-access'],
      params: Type.Object({ userId: Type.String({ format: 'uuid' }) }),
      body: Type.Object({
        level: Type.Enum(AdminLevel),
        reason: Type.String({ minLength: 1, maxLength: 500 }),
      }),
    },
  }, async (request) => setAdminLevel(
    prisma,
    actorOf(request),
    request.params.userId,
    request.body.level,
    request.body.reason,
  ));
}
