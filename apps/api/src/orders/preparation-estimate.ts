import type { MerchantPreparationStatus, OrderStatus, PrismaClient } from '@prisma/client';
import { Type, type Static } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import type { Actor } from '../auth/auth.js';
import { badRequest, conflict, forbidden, notFound } from '../shared/errors.js';
import { assertOrderAccess } from './access.js';

const timestampPattern = '^\\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\\d|3[01])T(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d{1,3})?(?:Z|[+-](?:[01]\\d|2[0-3]):[0-5]\\d)$';
export const PreparationEstimateBody = Type.Object({
  estimatedReadyAt: Type.String({ pattern: timestampPattern, description: 'Prediction with explicit UTC offset; past timestamps are stored honestly and immediately shown as overdue. Not a readiness or handoff guarantee.' }),
  expectedVersion: Type.Integer({ minimum: 0, maximum: 2147483646 }),
  requestKey: Type.String({ pattern: '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' }),
}, { additionalProperties: false });
export type PreparationEstimateInput = Static<typeof PreparationEstimateBody>;
export const PreparationEstimateView = Type.Object({
  estimatedReadyAt: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
  estimatedReadyAtLocal: Type.Union([Type.String(), Type.Null()]),
  timeZone: Type.String(), version: Type.Integer(), overdue: Type.Boolean(),
  updateReminder: Type.Boolean(), selfReported: Type.Boolean(),
}, { additionalProperties: false });
export const PreparationEstimateUpdateView = Type.Object({
  changed: Type.Boolean(), replayed: Type.Boolean(), recordedVersion: Type.Integer(), preparationEstimate: PreparationEstimateView,
}, { additionalProperties: false });
export const PreparationEstimateHistoryView = Type.Array(Type.Object({
  version: Type.Integer(), previousEstimatedReadyAt: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
  estimatedReadyAt: Type.String({ format: 'date-time' }), createdAt: Type.String({ format: 'date-time' }),
  actorId: Type.Optional(Type.String({ format: 'uuid' })),
}, { additionalProperties: false }));

type EstimateOrder = {
  status: OrderStatus;
  merchantPreparationStatus: MerchantPreparationStatus;
  merchantEstimatedReadyAt: Date | null;
  merchantPreparationEstimateVersion: number;
};
export function preparationEstimateView(order: EstimateOrder, timeZone: string, now: Date, merchant = false) {
  const ongoing = order.status === 'READY_FOR_RIDER' || order.status === 'CLAIMED';
  const overdue = Boolean(ongoing && order.merchantPreparationStatus !== 'READY_FOR_PICKUP'
    && order.merchantEstimatedReadyAt && now >= order.merchantEstimatedReadyAt);
  return {
    estimatedReadyAt: order.merchantEstimatedReadyAt,
    estimatedReadyAtLocal: order.merchantEstimatedReadyAt
      ? new Intl.DateTimeFormat('sv-SE', { timeZone, dateStyle: 'short', timeStyle: 'medium' }).format(order.merchantEstimatedReadyAt) : null,
    timeZone,
    version: order.merchantPreparationEstimateVersion,
    overdue,
    updateReminder: merchant && overdue,
    selfReported: true,
  };
}

function parsePrediction(input: PreparationEstimateInput) {
  if (!Value.Check(PreparationEstimateBody, input)) throw badRequest('INVALID_PREPARATION_ESTIMATE', 'Invalid prediction fields');
  const date = new Date(input.estimatedReadyAt);
  const [year, month, day] = input.estimatedReadyAt.slice(0, 10).split('-').map(Number);
  const leapYear = year! % 4 === 0 && (year! % 100 !== 0 || year! % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month! - 1]!;
  if (!Number.isFinite(date.getTime()) || year! < 1 || day! > daysInMonth) {
    throw badRequest('INVALID_PREPARATION_ESTIMATE', 'Use a valid timestamp with an explicit UTC offset');
  }
  return date;
}

export async function updatePreparationEstimate(prisma: PrismaClient, actor: Actor, orderId: string, input: PreparationEstimateInput, timeZone: string, clock = () => new Date()) {
  if (actor.role !== 'MERCHANT' || !actor.merchantId) throw forbidden();
  const estimatedReadyAt = parsePrediction(input);
  return prisma.$transaction(async (tx) => {
    // Pickup, claim and termination serialize on this same order row before the task row.
    await tx.$queryRaw`SELECT "id" FROM "Order" WHERE "id"=${orderId}::uuid FOR UPDATE`;
    const order = await tx.order.findUnique({ where: { id: orderId }, include: {
      merchant: { select: { ownerId: true } }, deliveryTask: { select: { pickedUpAt: true } },
    } });
    if (!order) throw notFound('Order');
    if (order.merchantId !== actor.merchantId || order.merchant.ownerId !== actor.id) throw forbidden();
    if (!['READY_FOR_RIDER', 'CLAIMED'].includes(order.status) || !order.deliveryTask || order.deliveryTask.pickedUpAt) {
      throw conflict('PREPARATION_STATE_CONFLICT', 'Predictions can only be updated after confirmation and before actual pickup or termination');
    }
    const prior = await tx.merchantPreparationEstimateAudit.findUnique({ where: { orderId_requestKey: { orderId, requestKey: input.requestKey } } });
    if (prior) {
      if (prior.actorId !== actor.id || prior.version !== input.expectedVersion + 1 || prior.estimatedReadyAt.getTime() !== estimatedReadyAt.getTime()) {
        throw conflict('PREPARATION_RETRY_CONFLICT', 'Request key was used for a different prediction');
      }
      return { changed: false, replayed: true, recordedVersion: prior.version, preparationEstimate: preparationEstimateView(order, timeZone, clock(), true) };
    }
    if (order.merchantPreparationEstimateVersion !== input.expectedVersion) throw conflict('PREPARATION_VERSION_CONFLICT', 'Refresh the current prediction version');
    const now = clock();
    const changed = await tx.order.updateMany({ where: { id: orderId, status: order.status, merchantPreparationEstimateVersion: input.expectedVersion },
      data: { merchantEstimatedReadyAt: estimatedReadyAt, merchantPreparationEstimateVersion: { increment: 1 } } });
    if (changed.count !== 1) throw conflict('PREPARATION_VERSION_CONFLICT', 'Prediction changed concurrently');
    await tx.merchantPreparationEstimateAudit.create({ data: { orderId, version: input.expectedVersion + 1,
      previousEstimatedReadyAt: order.merchantEstimatedReadyAt, estimatedReadyAt, actorId: actor.id, requestKey: input.requestKey, createdAt: now } });
    await tx.orderEvent.create({ data: { orderId, eventType: 'MERCHANT_PREPARATION_UPDATED', actorType: 'USER',
      fromStatus: order.status, toStatus: order.status, operatorId: actor.id, operatorRole: actor.role, createdAt: now,
      metadata: { kind: 'ESTIMATE', version: input.expectedVersion + 1, previousEstimatedReadyAt: order.merchantEstimatedReadyAt?.toISOString() ?? null, estimatedReadyAt: estimatedReadyAt.toISOString(), selfReported: true } } });
    return { changed: true, replayed: false, recordedVersion: input.expectedVersion + 1,
      preparationEstimate: preparationEstimateView({ ...order, merchantEstimatedReadyAt: estimatedReadyAt, merchantPreparationEstimateVersion: input.expectedVersion + 1 }, timeZone, now, true) };
  });
}

export async function listPreparationEstimates(prisma: PrismaClient, actor: Actor, orderId: string) {
  return prisma.$transaction(async (tx) => {
    const order = await tx.order.findUnique({ where: { id: orderId }, select: { customerId: true, merchantId: true,
      merchant: { select: { ownerId: true } }, deliveryTask: { select: { riderId: true, assignments: { where: { status: 'ACTIVE' }, select: { riderId: true } } } } } });
    if (!order) throw notFound('Order');
    assertOrderAccess(actor, order);
    if (actor.role === 'MERCHANT' && order.merchant.ownerId !== actor.id) throw forbidden();
    if (actor.role === 'RIDER' && !order.deliveryTask?.assignments.some((a) => a.riderId === actor.riderId)) throw forbidden();
    const privateAudit = actor.role === 'MERCHANT' || actor.role === 'ADMIN';
    return tx.merchantPreparationEstimateAudit.findMany({ where: { orderId }, orderBy: { version: 'asc' }, select: {
      version: true, previousEstimatedReadyAt: true, estimatedReadyAt: true, createdAt: true, ...(privateAudit ? { actorId: true } : {}),
    } });
  }, { isolationLevel: 'RepeatableRead' });
}
