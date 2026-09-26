import { AdminLevel, type PrismaClient } from '@prisma/client';
import { requireAdminLevel, type Actor } from '../auth/auth.js';
import { conflict, notFound } from '../shared/errors.js';

export async function setAdminLevel(
  prisma: PrismaClient,
  actor: Actor,
  userId: string,
  level: AdminLevel,
  reason: string,
) {
  requireAdminLevel(actor, [AdminLevel.SUPER_ADMIN]);
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${userId}::uuid FOR UPDATE`;
    const user = await tx.user.findUnique({ where: { id: userId }, include: { adminProfile: true } });
    if (!user) throw notFound('User');
    if (user.role !== 'ADMIN') throw conflict('USER_NOT_ADMIN', 'Only ADMIN users can receive an admin level');
    const profile = await tx.adminProfile.upsert({
      where: { userId },
      update: { level },
      create: { userId, level },
    });
    await tx.adminProfileAudit.create({
      data: {
        targetUserId: userId,
        actorId: actor.id,
        ...(user.adminProfile ? { previousLevel: user.adminProfile.level } : {}),
        newLevel: level,
        reason,
      },
    });
    return { userId, level: profile.level };
  });
}
