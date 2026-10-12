import { MerchantExposureState, type Prisma, type PrismaClient } from '@prisma/client';
import { Type, type Static } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import type { Actor } from '../auth/auth.js';
import { badRequest, conflict, forbidden, notFound } from '../shared/errors.js';
import { dailyConfirmationConfigLock } from './daily-confirmation-config.js';
import { readConfirmationState, type confirmationPreferenceFields } from './daily-confirmation-state.js';

export const OperatingStatusBody = Type.Object({
  isOpen: Type.Boolean(),
  expectedVersion: Type.Integer({ minimum: 0, maximum: 2147483646 }),
  reason: Type.String({ minLength: 1, maxLength: 500, pattern: '\\S' }),
}, { additionalProperties: false });
export type OperatingStatusInput = Static<typeof OperatingStatusBody>;
export const ConfirmBusinessDayBody = Type.Object({ expectedVersion: OperatingStatusBody.properties.expectedVersion,
  reason: OperatingStatusBody.properties.reason }, { additionalProperties: false });
export type ConfirmBusinessDayInput = Static<typeof ConfirmBusinessDayBody>;

export function operatingStatusFields(merchant: { isOpen: boolean; exposureState: MerchantExposureState }, confirmation?: Pick<ReturnType<typeof confirmationPreferenceFields>, 'active' | 'confirmedToday' | 'businessDay'>) {
  const acceptingOrders = merchant.isOpen && merchant.exposureState !== 'HIDDEN' && merchant.exposureState !== 'SUSPENDED'
    && (!confirmation?.active || confirmation.confirmedToday);
  return {
    acceptingOrders,
    operatingStatusLabel: acceptingOrders ? '营业中' : '休息中',
    ...(confirmation ? { businessDay: confirmation.businessDay, confirmedToday: confirmation.confirmedToday } : {}),
  };
}

export async function lockOwnMerchant(tx: Prisma.TransactionClient, actor: Actor, write = true) {
  if (actor.role !== 'MERCHANT' || !actor.merchantId) throw forbidden();
  // Checkout takes FOR SHARE at this same point in config -> merchant -> catalog -> locations.
  if (write) await tx.$queryRaw`SELECT "id" FROM "Merchant" WHERE "id" = ${actor.merchantId}::uuid FOR UPDATE`;
  else await tx.$queryRaw`SELECT "id" FROM "Merchant" WHERE "id" = ${actor.merchantId}::uuid FOR SHARE`;
  const merchant = await tx.merchant.findFirst({ where: { id: actor.merchantId, ownerId: actor.id },
    select: { id: true, isOpen: true, operatingVersion: true, exposureState: true,
      dailyProductRestoreEnabled: true, dailyProductRestoreVersion: true,
      dailyConfirmationEnabled: true, dailyConfirmationVersion: true, dailyConfirmationEffectiveAt: true } });
  if (!merchant) throw notFound('Own merchant');
  return merchant;
}

const auditSelect = { version: true, previousIsOpen: true, newIsOpen: true, actorId: true, reason: true, createdAt: true } as const;
const ownStatus = (merchant: Awaited<ReturnType<typeof lockOwnMerchant>>, state: Awaited<ReturnType<typeof readConfirmationState>>) => ({
  id: merchant.id, isOpen: merchant.isOpen, operatingVersion: merchant.operatingVersion, ...operatingStatusFields(merchant, state.fields),
  operatingStatusLabel: merchant.isOpen && state.fields.active && !state.fields.confirmedToday ? '待今日确认' : operatingStatusFields(merchant, state.fields).operatingStatusLabel,
  confirmationRequired: state.fields.active, dailyConfirmation: state.fields, confirmation: state.confirmation,
});

export async function getOperatingStatus(prisma: PrismaClient, actor: Actor, timeZone = 'Asia/Shanghai') {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock_shared(${dailyConfirmationConfigLock})`;
    const merchant = await lockOwnMerchant(tx, actor, false);
    const history = await tx.merchantOperatingStatusAudit.findMany({ where: { merchantId: merchant.id },
      orderBy: { version: 'desc' }, take: 100, select: auditSelect });
    const state = await readConfirmationState(tx, merchant, timeZone);
    return { ...ownStatus(merchant, state), history };
  });
}

export async function updateOperatingStatus(prisma: PrismaClient, actor: Actor, input: OperatingStatusInput, timeZone = 'Asia/Shanghai') {
  if (!Value.Check(OperatingStatusBody, input)) throw badRequest('INVALID_OPERATING_STATUS', 'Invalid operating status fields');
  return commitOperatingStatus(prisma, actor, input, timeZone, false);
}

export async function confirmBusinessDay(prisma: PrismaClient, actor: Actor, input: ConfirmBusinessDayInput, timeZone = 'Asia/Shanghai') {
  if (!Value.Check(ConfirmBusinessDayBody, input)) throw badRequest('INVALID_BUSINESS_DAY_CONFIRMATION', 'Invalid confirmation fields');
  return commitOperatingStatus(prisma, actor, { ...input, isOpen: true }, timeZone, true);
}

async function commitOperatingStatus(prisma: PrismaClient, actor: Actor, input: OperatingStatusInput, timeZone: string, explicit: boolean) {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock_shared(${dailyConfirmationConfigLock})`;
    const merchant = await lockOwnMerchant(tx, actor);
    if (merchant.operatingVersion !== input.expectedVersion) throw conflict('OPERATING_VERSION_CONFLICT', 'Refresh your operating status');
    const state = await readConfirmationState(tx, merchant, timeZone);
    // Preserve default manual no-op behavior; opted-in manual opens also confirm while activation is pending.
    const shouldConfirm = input.isOpen && (explicit || merchant.dailyConfirmationEnabled) && !state.fields.confirmedToday;
    if (merchant.isOpen === input.isOpen && !shouldConfirm) return { ...ownStatus(merchant, state), changed: false };
    const changed = await tx.merchant.updateMany({ where: { id: merchant.id, ownerId: actor.id, operatingVersion: input.expectedVersion },
      data: { isOpen: input.isOpen, operatingVersion: { increment: 1 } } });
    if (changed.count !== 1) throw conflict('OPERATING_VERSION_CONFLICT', 'Refresh your operating status');
    if (shouldConfirm) {
      await tx.merchantBusinessDayConfirmation.create({ data: { merchantId: merchant.id, businessDayStartsAt: state.schedule.startsAt,
        businessDay: new Date(`${state.schedule.day}T00:00:00Z`), timeZone: state.schedule.timeZone, switchingTime: state.schedule.time,
        policyVersion: state.schedule.version, source: explicit ? 'EXPLICIT_CONFIRM' : 'MANUAL_OPEN', actorId: actor.id,
        operatingVersion: input.expectedVersion + 1, reason: input.reason.trim(), confirmedAt: new Date() } });
    }
    const audit = await tx.merchantOperatingStatusAudit.create({ data: { merchantId: merchant.id,
      version: input.expectedVersion + 1, previousIsOpen: merchant.isOpen, newIsOpen: input.isOpen,
      actorId: actor.id, reason: input.reason.trim() }, select: auditSelect });
    if (shouldConfirm && new Date() >= state.schedule.nextStartsAt) throw conflict('BUSINESS_DAY_CHANGED', 'Confirm again after the business-day boundary');
    const after = { ...merchant, isOpen: input.isOpen, operatingVersion: audit.version };
    const afterState = await readConfirmationState(tx, after, timeZone);
    return { ...ownStatus(after, afterState), changed: true, audit };
  });
}
