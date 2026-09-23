import type { Prisma, PrismaClient } from '@prisma/client';
import type { Actor } from '../auth/auth.js';
import { validatePolicyPayload } from '../merchant-policy/policies.js';
import { forbidden, notFound } from '../shared/errors.js';

export async function getBusinessConfig(prisma: PrismaClient, actor: Actor, key: string) {
  if (actor.role !== 'ADMIN') throw forbidden();
  const config = await prisma.businessConfig.findFirst({
    where: { key, isActive: true },
    orderBy: { version: 'desc' },
  });
  if (!config) throw notFound('Business config');
  const audit = await prisma.businessConfigAudit.findMany({
    where: { key },
    orderBy: { createdAt: 'desc' },
    take: 100,
  });
  return { config, audit };
}

export async function updateBusinessConfig(
  prisma: PrismaClient,
  actor: Actor,
  key: string,
  payload: Prisma.InputJsonValue,
  reason: string,
) {
  if (actor.role !== 'ADMIN') throw forbidden();
  const validatedPayload = key === 'ORDER_POLICY'
    ? validatePolicyPayload(payload as Prisma.JsonValue)
    : payload;

  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "BusinessConfig" WHERE "key" = ${key} FOR UPDATE`;
    const current = await tx.businessConfig.findFirst({
      where: { key, isActive: true },
      orderBy: { version: 'desc' },
    });
    const nextVersion = (current?.version ?? 0) + 1;
    if (current) {
      await tx.businessConfig.update({ where: { id: current.id }, data: { isActive: false } });
    }
    const next = await tx.businessConfig.create({
      data: {
        key,
        version: nextVersion,
        isActive: true,
        payload: validatedPayload as Prisma.InputJsonValue,
      },
    });
    await tx.businessConfigAudit.create({
      data: {
        key,
        ...(current ? { previousVersion: current.version } : {}),
        ...(current && current.payload !== null ? { beforePayload: current.payload as Prisma.InputJsonValue } : {}),
        newVersion: nextVersion,
        actorId: actor.id,
        afterPayload: validatedPayload as Prisma.InputJsonValue,
        reason,
      },
    });
    return next;
  });
}
