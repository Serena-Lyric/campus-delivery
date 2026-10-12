import type { Prisma } from '@prisma/client';
import { conflict } from '../shared/errors.js';
import { loadDailyConfirmationSchedule, type ConfirmationSchedule } from './daily-confirmation-config.js';

export const confirmationPreferenceSelect = { dailyConfirmationEnabled: true, dailyConfirmationVersion: true, dailyConfirmationEffectiveAt: true } as const;
export type ConfirmationPreference = { dailyConfirmationEnabled: boolean; dailyConfirmationVersion: number; dailyConfirmationEffectiveAt: Date | null };
export function confirmationPreferenceFields(merchant: ConfirmationPreference, schedule: ConfirmationSchedule, confirmedToday = false) {
  const active = merchant.dailyConfirmationEnabled && merchant.dailyConfirmationEffectiveAt !== null && merchant.dailyConfirmationEffectiveAt <= schedule.startsAt;
  const { time, version, source, timeZone, effectiveAt, configuredTime, configuredVersion, pending, configuredEffectiveAt } = schedule;
  return { enabled: merchant.dailyConfirmationEnabled, version: merchant.dailyConfirmationVersion, effectiveAt: merchant.dailyConfirmationEffectiveAt,
    active, pendingActivation: merchant.dailyConfirmationEnabled && !active, businessDay: schedule.day, businessDayStartsAt: schedule.startsAt,
    nextBusinessDayStartsAt: schedule.nextStartsAt, confirmedToday,
    schedule: { time, version, source, timeZone, effectiveAt, configuredTime, configuredVersion, pending, configuredEffectiveAt } };
}
export const confirmationSelect = { businessDay: true, businessDayStartsAt: true, timeZone: true, switchingTime: true, policyVersion: true,
  source: true, actorId: true, operatingVersion: true, reason: true, confirmedAt: true } as const;
export function confirmationDto(row: Prisma.MerchantBusinessDayConfirmationGetPayload<{ select: typeof confirmationSelect }> | null) {
  if (!row) return null;
  return { businessDay: row.businessDay.toISOString().slice(0, 10), businessDayStartsAt: row.businessDayStartsAt, timeZone: row.timeZone,
    switchingTime: row.switchingTime, policyVersion: row.policyVersion, source: row.source, actorId: row.actorId,
    operatingVersion: row.operatingVersion, reason: row.reason, confirmedAt: row.confirmedAt };
}
// Callers hold the shared config lock and merchant SHARE/UPDATE lock. Read time after all lock waits.
export async function readConfirmationState(tx: Prisma.TransactionClient, merchant: ConfirmationPreference & { id: string }, timeZone: string) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const schedule = await loadDailyConfirmationSchedule(tx, timeZone);
    const row = await tx.merchantBusinessDayConfirmation.findUnique({ where: { merchantId_businessDayStartsAt: {
      merchantId: merchant.id, businessDayStartsAt: schedule.startsAt } }, select: confirmationSelect });
    if (new Date() >= schedule.nextStartsAt) continue;
    return { schedule, confirmation: confirmationDto(row), fields: confirmationPreferenceFields(merchant, schedule, row !== null) };
  }
  throw conflict('BUSINESS_DAY_CHANGED', 'Refresh after the business-day boundary');
}

export async function readConfirmationBatch(tx: Prisma.TransactionClient, merchants: Array<ConfirmationPreference & { id: string }>, timeZone: string) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const schedule = await loadDailyConfirmationSchedule(tx, timeZone);
    const rows = await tx.merchantBusinessDayConfirmation.findMany({ where: { merchantId: { in: merchants.map((m) => m.id) }, businessDayStartsAt: schedule.startsAt }, select: { merchantId: true } });
    if (new Date() >= schedule.nextStartsAt) continue;
    const confirmed = new Set(rows.map((row) => row.merchantId));
    return new Map(merchants.map((merchant) => [merchant.id, confirmationPreferenceFields(merchant, schedule, confirmed.has(merchant.id))]));
  }
  throw conflict('BUSINESS_DAY_CHANGED', 'Refresh after the business-day boundary');
}
