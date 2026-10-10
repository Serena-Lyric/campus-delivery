import type { Prisma, PrismaClient } from '@prisma/client';
import { Type, type Static } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { AppError, badRequest } from '../shared/errors.js';

export const deliveryPricingPolicyKey = 'DELIVERY_PRICING_POLICY';
// Shared by config writers and order/preview readers, including the unconfigured state.
export const pricingConfigLock = 17201012;
export const maxStoredMinor = 2_147_483_647;
export const fallbackQuoteLimitMinor = 100_000;

export const DeliveryPricingConfigSchema = Type.Union([
  Type.Object({ mode: Type.Literal('LEGACY_ORDER_POLICY') }, { additionalProperties: false }),
  Type.Object({
    mode: Type.Literal('REFERENCE_BPS'),
    customerMarkupBps: Type.Integer({ minimum: 0, maximum: 10_000 }),
    riderDeductionBps: Type.Integer({ minimum: 0, maximum: 10_000 }),
    rounding: Type.Literal('FLOOR_ADJUSTMENTS'),
    // Engineering input ceiling; not an approved commercial price or minimum charge.
    maxMerchantBaseMinor: Type.Integer({ minimum: 1, maximum: 1_073_741_823 }),
  }, { additionalProperties: false }),
]);

export type DeliveryPricingConfig = Static<typeof DeliveryPricingConfigSchema>;
export type VersionedDeliveryPricingConfig = { version: number; config: DeliveryPricingConfig };

export function validateDeliveryPricingConfig(payload: Prisma.JsonValue): DeliveryPricingConfig {
  if (!Value.Check(DeliveryPricingConfigSchema, payload)) {
    throw badRequest('INVALID_DELIVERY_PRICING_CONFIG', 'Explicit mode, independent integer BPS (0..10000), rounding and a safe quote limit are required');
  }
  return payload as DeliveryPricingConfig;
}

export async function loadDeliveryPricingConfig(db: PrismaClient | Prisma.TransactionClient): Promise<VersionedDeliveryPricingConfig> {
  const row = await db.businessConfig.findFirst({
    where: { key: deliveryPricingPolicyKey, isActive: true }, orderBy: { version: 'desc' },
  });
  if (!row) return { version: 0, config: { mode: 'LEGACY_ORDER_POLICY' } };
  try {
    return { version: row.version, config: validateDeliveryPricingConfig(row.payload) };
  } catch (error) {
    if (error instanceof AppError) throw new AppError(500, error.code, error.message);
    throw error;
  }
}

export function assertStoredMinor(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > maxStoredMinor) {
    throw badRequest('MONEY_OUT_OF_RANGE', 'Price must fit a non-negative PostgreSQL integer in minor units');
  }
  return value;
}
