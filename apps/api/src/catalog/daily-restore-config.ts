import type { Prisma, PrismaClient } from '@prisma/client';
import { Type } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { AppError, badRequest } from '../shared/errors.js';

export const dailyRestoreKey = 'PRODUCT_DAILY_RESTORE';
// Config first, then merchant, then products. Shared even before any config row exists.
export const dailyRestoreConfigLock = 17201013;
export const DailyRestoreConfigBody = Type.Object({
  time: Type.String({ pattern: '^([01][0-9]|2[0-3]):[0-5][0-9]$' }),
}, { additionalProperties: false });
export function validateDailyRestoreConfig(payload: Prisma.JsonValue): { time: string } {
  if (!Value.Check(DailyRestoreConfigBody, payload)) throw badRequest('INVALID_DAILY_RESTORE_CONFIG', 'A local HH:mm time is required');
  return payload as { time: string };
}
export async function loadDailyRestoreConfig(db: PrismaClient | Prisma.TransactionClient, timeZone: string) {
  const row = await db.businessConfig.findFirst({ where: { key: dailyRestoreKey, isActive: true }, orderBy: { version: 'desc' } });
  if (!row) return { time: '04:00', version: 0, source: 'SYSTEM_DEFAULT', timeZone };
  try { return { ...validateDailyRestoreConfig(row.payload), version: row.version, source: 'ADMIN_CONFIG', timeZone }; }
  catch (error) {
    if (error instanceof AppError) throw new AppError(500, error.code, error.message);
    throw error;
  }
}
