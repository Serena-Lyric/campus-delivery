import type { Prisma, PrismaClient } from '@prisma/client';
import { Type } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { AppError, badRequest } from '../shared/errors.js';
import { businessDayInterval, campusDay } from '../shared/time.js';

export const dailyConfirmationKey = 'MERCHANT_DAILY_CONFIRMATION';
export const dailyConfirmationConfigLock = 17201014;
const Time = Type.String({ pattern: '^([01][0-9]|2[0-3]):[0-5][0-9]$' });
const Instant = Type.String({ pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$' });
export const DailyConfirmationConfigBody = Type.Object({ time: Time }, { additionalProperties: false });
const StoredConfig = Type.Object({ time: Time, timeZone: Type.String(), effectiveAt: Instant, transitionDayStart: Instant,
  previous: Type.Object({ time: Time, version: Type.Integer({ minimum: 0 }), effectiveAt: Type.Union([Instant, Type.Null()]) }, { additionalProperties: false }),
}, { additionalProperties: false });
type StoredSchedule = { time: string; timeZone: string; effectiveAt: string; transitionDayStart: string;
  previous: { time: string; version: number; effectiveAt: string | null } };
export function validateDailyConfirmationConfig(payload: Prisma.JsonValue): { time: string } {
  if (!Value.Check(DailyConfirmationConfigBody, payload)) throw badRequest('INVALID_DAILY_CONFIRMATION_CONFIG', 'Only a local HH:mm time is permitted');
  return payload as { time: string };
}

export async function loadDailyConfirmationSchedule(db: PrismaClient | Prisma.TransactionClient, timeZone: string, now = new Date()) {
  const row = await db.businessConfig.findFirst({ where: { key: dailyConfirmationKey, isActive: true }, orderBy: { version: 'desc' } });
  if (!row) return { time: '04:00', version: 0, source: 'SYSTEM_DEFAULT', timeZone, effectiveAt: null,
    configuredTime: '04:00', configuredVersion: 0, pending: false, configuredEffectiveAt: null,
    ...businessDayInterval(now, timeZone, '04:00') };
  if (!Value.Check(StoredConfig, row.payload)) throw new AppError(500, 'INVALID_DAILY_CONFIRMATION_CONFIG', 'Invalid stored business-day transition');
  const stored = row.payload as unknown as StoredSchedule;
  if ([stored.effectiveAt, stored.transitionDayStart, stored.previous.effectiveAt].some((value) => value !== null && !Number.isFinite(Date.parse(value)))) {
    throw new AppError(500, 'INVALID_DAILY_CONFIRMATION_CONFIG', 'Invalid stored transition timestamp');
  }
  if (stored.timeZone !== timeZone) throw new AppError(500, 'CONFIRMATION_TIME_ZONE_MISMATCH', 'Business-day policy requires a reviewed time-zone migration');
  const effectiveAt = new Date(stored.effectiveAt);
  const pending = now < effectiveAt;
  const active = pending ? stored.previous : { time: stored.time, version: row.version, effectiveAt: stored.effectiveAt };
  const interval = businessDayInterval(now, timeZone, active.time);
  const startsAt = pending ? new Date(stored.transitionDayStart) : new Date(Math.max(interval.startsAt.getTime(), effectiveAt.getTime()));
  return { time: active.time, version: active.version, source: active.version === 0 ? 'SYSTEM_DEFAULT' : 'ADMIN_CONFIG', timeZone,
    effectiveAt: active.effectiveAt, configuredTime: stored.time, configuredVersion: row.version, pending,
    configuredEffectiveAt: stored.effectiveAt, day: campusDay(startsAt, timeZone).toISOString().slice(0, 10), startsAt,
    nextStartsAt: pending ? effectiveAt : interval.nextStartsAt };
}
export type ConfirmationSchedule = Awaited<ReturnType<typeof loadDailyConfirmationSchedule>>;

export async function prepareDailyConfirmationConfig(db: Prisma.TransactionClient, time: string, timeZone: string, now = new Date()): Promise<Prisma.InputJsonObject> {
  const current = await loadDailyConfirmationSchedule(db, timeZone, now);
  const candidate = businessDayInterval(now, timeZone, time).nextStartsAt;
  return { time, timeZone, effectiveAt: new Date(Math.max(current.nextStartsAt.getTime(), candidate.getTime())).toISOString(),
    transitionDayStart: current.startsAt.toISOString(),
    previous: { time: current.time, version: current.version, effectiveAt: current.effectiveAt } };
}
