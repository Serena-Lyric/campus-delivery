import type { Prisma, PrismaClient } from '@prisma/client';
import { requireAdminLevel, type Actor } from '../auth/auth.js';
import { validatePolicyPayload } from '../merchant-policy/policies.js';
import { badRequest, conflict, notFound } from '../shared/errors.js';
import { eligibilityPolicyKey, eligibilityPolicyLock, validateEligibilityPolicy } from '../riders/eligibility-gate.js';

export async function getBusinessConfig(prisma: PrismaClient, actor: Actor, key: string) {
  requireAdminLevel(actor, ['SUPER_ADMIN']);
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
  expectedVersion?: number,
) {
  requireAdminLevel(actor, ['SUPER_ADMIN']);
  const validatedPayload = key === 'ORDER_POLICY'
    ? validatePolicyPayload(payload as Prisma.JsonValue)
    : key === eligibilityPolicyKey ? validateEligibilityPolicy(payload as Prisma.JsonValue) : payload;
  if (key === eligibilityPolicyKey && expectedVersion === undefined) {
    throw badRequest('CONFIG_VERSION_REQUIRED', 'Qualification enforcement requires the expected config version (0 when unconfigured)');
  }

  return prisma.$transaction(async (tx) => {
    if (key === eligibilityPolicyKey) await tx.$executeRaw`SELECT pg_advisory_xact_lock(${eligibilityPolicyLock})`;
    await tx.$queryRaw`SELECT "id" FROM "BusinessConfig" WHERE "key" = ${key} FOR UPDATE`;
    const current = await tx.businessConfig.findFirst({
      where: { key, isActive: true },
      orderBy: { version: 'desc' },
    });
    const nextVersion = (current?.version ?? 0) + 1;
    if (expectedVersion !== undefined && expectedVersion !== (current?.version ?? 0)) throw conflict('CONFIG_VERSION_CONFLICT', 'Refresh the business config before changing it');
    if (key === eligibilityPolicyKey && validateEligibilityPolicy(validatedPayload as Prisma.JsonValue).enforced) {
      const now = new Date();
      if (!await tx.academicTerm.findFirst({ where: { startsAt: { lte: now }, endsAt: { gt: now } }, select: { id: true } })) {
        throw conflict('ACADEMIC_CALENDAR_REQUIRED', 'Configure the current academic term before enabling qualification enforcement');
      }
    }
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
