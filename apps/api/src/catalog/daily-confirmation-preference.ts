import type { PrismaClient } from '@prisma/client';
import { Type, type Static } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import type { Actor } from '../auth/auth.js';
import { badRequest, conflict } from '../shared/errors.js';
import { lockOwnMerchant } from './operating-status.js';
import { dailyConfirmationConfigLock } from './daily-confirmation-config.js';
import { confirmationPreferenceFields, readConfirmationState } from './daily-confirmation-state.js';

export const DailyConfirmationPreferenceBody = Type.Object({ enabled: Type.Boolean(), expectedVersion: Type.Integer({ minimum: 0, maximum: 2147483646 }),
  reason: Type.String({ minLength: 1, maxLength: 500, pattern: '\\S' }) }, { additionalProperties: false });
export type DailyConfirmationPreferenceInput = Static<typeof DailyConfirmationPreferenceBody>;
const NullableInstant = Type.Union([Type.String({ format: 'date-time' }), Type.Null()]);
export const ConfirmationScheduleView = Type.Object({ time: Type.String(), version: Type.Integer(), source: Type.String(), timeZone: Type.String(),
  effectiveAt: NullableInstant, configuredTime: Type.String(), configuredVersion: Type.Integer(), pending: Type.Boolean(), configuredEffectiveAt: NullableInstant,
}, { additionalProperties: false });
const AuditView = Type.Object({ version: Type.Integer(), previousEnabled: Type.Boolean(), newEnabled: Type.Boolean(),
  effectiveAt: NullableInstant, actorId: Type.String({ format: 'uuid' }), reason: Type.String(), createdAt: Type.String({ format: 'date-time' }) }, { additionalProperties: false });
export const confirmationViewFields = { enabled: Type.Boolean(), version: Type.Integer(), effectiveAt: NullableInstant, active: Type.Boolean(),
  pendingActivation: Type.Boolean(), businessDay: Type.String(), businessDayStartsAt: Type.String({ format: 'date-time' }),
  nextBusinessDayStartsAt: Type.String({ format: 'date-time' }), confirmedToday: Type.Boolean(), schedule: ConfirmationScheduleView };
export const DailyConfirmationPreferenceView = Type.Object({ ...confirmationViewFields, history: Type.Array(AuditView) }, { additionalProperties: false });
export const DailyConfirmationPreferenceUpdateView = Type.Object({ ...confirmationViewFields, changed: Type.Boolean(), audit: Type.Optional(AuditView) }, { additionalProperties: false });
const auditSelect = { version: true, previousEnabled: true, newEnabled: true, effectiveAt: true, actorId: true, reason: true, createdAt: true } as const;
export async function getDailyConfirmationPreference(prisma: PrismaClient, actor: Actor, timeZone: string) {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock_shared(${dailyConfirmationConfigLock})`;
    const merchant = await lockOwnMerchant(tx, actor, false);
    const state = await readConfirmationState(tx, merchant, timeZone);
    const history = await tx.merchantDailyConfirmationPreferenceAudit.findMany({ where: { merchantId: merchant.id }, orderBy: { version: 'desc' }, take: 100, select: auditSelect });
    return { ...state.fields, history };
  });
}
export async function updateDailyConfirmationPreference(prisma: PrismaClient, actor: Actor, input: DailyConfirmationPreferenceInput, timeZone: string) {
  if (!Value.Check(DailyConfirmationPreferenceBody, input)) throw badRequest('INVALID_DAILY_CONFIRMATION_PREFERENCE', 'Invalid daily confirmation fields');
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock_shared(${dailyConfirmationConfigLock})`;
    const merchant = await lockOwnMerchant(tx, actor);
    const { schedule, fields } = await readConfirmationState(tx, merchant, timeZone);
    if (merchant.dailyConfirmationVersion !== input.expectedVersion) throw conflict('DAILY_CONFIRMATION_VERSION_CONFLICT', 'Refresh your daily confirmation preference');
    if (merchant.dailyConfirmationEnabled === input.enabled) return { ...fields, changed: false };
    const effectiveAt = input.enabled ? schedule.nextStartsAt : null;
    const result = await tx.merchant.updateMany({ where: { id: merchant.id, ownerId: actor.id, dailyConfirmationVersion: input.expectedVersion },
      data: { dailyConfirmationEnabled: input.enabled, dailyConfirmationEffectiveAt: effectiveAt, dailyConfirmationVersion: { increment: 1 } } });
    if (result.count !== 1) throw conflict('DAILY_CONFIRMATION_VERSION_CONFLICT', 'Refresh your daily confirmation preference');
    const audit = await tx.merchantDailyConfirmationPreferenceAudit.create({ data: { merchantId: merchant.id, version: input.expectedVersion + 1,
      previousEnabled: merchant.dailyConfirmationEnabled, newEnabled: input.enabled, effectiveAt, actorId: actor.id, reason: input.reason.trim() }, select: auditSelect });
    return { ...confirmationPreferenceFields({ dailyConfirmationEnabled: input.enabled, dailyConfirmationVersion: audit.version, dailyConfirmationEffectiveAt: effectiveAt }, schedule, fields.confirmedToday), changed: true, audit };
  });
}
