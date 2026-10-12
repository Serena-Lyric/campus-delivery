import type { PrismaClient } from '@prisma/client';
import { Type, type Static } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import type { Actor } from '../auth/auth.js';
import { badRequest, conflict } from '../shared/errors.js';
import { lockOwnMerchant } from './operating-status.js';
import { dailyRestoreConfigLock, loadDailyRestoreConfig } from './daily-restore-config.js';

export const DailyRestorePreferenceBody = Type.Object({
  enabled: Type.Boolean(), expectedVersion: Type.Integer({ minimum: 0, maximum: 2147483646 }),
  reason: Type.String({ minLength: 1, maxLength: 500, pattern: '\\S' }),
}, { additionalProperties: false });
export type DailyRestorePreferenceInput = Static<typeof DailyRestorePreferenceBody>;
const ScheduleView = Type.Object({ time: Type.String(), version: Type.Integer(),
  source: Type.Union([Type.Literal('SYSTEM_DEFAULT'), Type.Literal('ADMIN_CONFIG')]), timeZone: Type.String() }, { additionalProperties: false });
const PreferenceAuditView = Type.Object({ version: Type.Integer(), previousEnabled: Type.Boolean(), newEnabled: Type.Boolean(),
  actorId: Type.String({ format: 'uuid' }), reason: Type.String(), createdAt: Type.String({ format: 'date-time' }) }, { additionalProperties: false });
const preferenceFields = { enabled: Type.Boolean(), version: Type.Integer(), schedule: ScheduleView };
export const DailyRestorePreferenceView = Type.Object({ ...preferenceFields, history: Type.Array(PreferenceAuditView) }, { additionalProperties: false });
export const DailyRestorePreferenceUpdateView = Type.Object({ ...preferenceFields, changed: Type.Boolean(), audit: Type.Optional(PreferenceAuditView) }, { additionalProperties: false });
const auditSelect = { version: true, previousEnabled: true, newEnabled: true, actorId: true, reason: true, createdAt: true } as const;
const view = (m: Awaited<ReturnType<typeof lockOwnMerchant>>) => ({ enabled: m.dailyProductRestoreEnabled, version: m.dailyProductRestoreVersion });
export async function getDailyRestorePreference(prisma: PrismaClient, actor: Actor, timeZone: string) {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock_shared(${dailyRestoreConfigLock})`;
    const schedule = await loadDailyRestoreConfig(tx, timeZone);
    const merchant = await lockOwnMerchant(tx, actor, false);
    const history = await tx.merchantDailyRestorePreferenceAudit.findMany({ where: { merchantId: merchant.id }, orderBy: { version: 'desc' }, take: 100, select: auditSelect });
    return { ...view(merchant), schedule, history };
  });
}
export async function updateDailyRestorePreference(prisma: PrismaClient, actor: Actor, input: DailyRestorePreferenceInput, timeZone: string) {
  if (!Value.Check(DailyRestorePreferenceBody, input)) throw badRequest('INVALID_DAILY_RESTORE_PREFERENCE', 'Invalid daily restore preference fields');
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock_shared(${dailyRestoreConfigLock})`;
    const schedule = await loadDailyRestoreConfig(tx, timeZone);
    const merchant = await lockOwnMerchant(tx, actor);
    if (merchant.dailyProductRestoreVersion !== input.expectedVersion) throw conflict('DAILY_RESTORE_VERSION_CONFLICT', 'Refresh your daily restore preference');
    if (merchant.dailyProductRestoreEnabled === input.enabled) return { ...view(merchant), schedule, changed: false };
    const changed = await tx.merchant.updateMany({ where: { id: merchant.id, ownerId: actor.id, dailyProductRestoreVersion: input.expectedVersion },
      data: { dailyProductRestoreEnabled: input.enabled, dailyProductRestoreVersion: { increment: 1 } } });
    if (changed.count !== 1) throw conflict('DAILY_RESTORE_VERSION_CONFLICT', 'Refresh your daily restore preference');
    const audit = await tx.merchantDailyRestorePreferenceAudit.create({ data: { merchantId: merchant.id, version: input.expectedVersion + 1,
      previousEnabled: merchant.dailyProductRestoreEnabled, newEnabled: input.enabled, actorId: actor.id, reason: input.reason.trim() }, select: auditSelect });
    return { enabled: input.enabled, version: audit.version, schedule, changed: true, audit };
  });
}
