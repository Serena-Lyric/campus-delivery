import {
  DeliveryMethod,
  DeliveryVerificationMode,
  MerchantExposureState,
  PickupVerificationMode,
  type Prisma,
  type PrismaClient,
} from '@prisma/client';
import { Type, type Static } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { AppError } from '../shared/errors.js';
import { assertMinor } from '../shared/money.js';

export const PolicyConfigSchema = Type.Object({
  customerDeliveryFeeMinor: Type.Integer({ minimum: 0 }),
  platformCommissionBps: Type.Integer({ minimum: 0, maximum: 10_000 }),
  subsidyEnabled: Type.Boolean(),
  coolingOffSeconds: Type.Integer({ minimum: 0 }),
  verificationCodeTtlSeconds: Type.Integer({ minimum: 1 }),
  riderSettlementPendingSeconds: Type.Integer({ minimum: 0 }),
  platformMaxConcurrentOrdersPerRider: Type.Integer({ minimum: 1 }),
  customerUnreachableWaitSeconds: Type.Integer({ minimum: 0 }),
  merchantRepriceCooldownSeconds: Type.Integer({ minimum: 0 }),
  orderClaimWindowSeconds: Type.Integer({ minimum: 1 }),
  defaultNaturalClaimBaselineSeconds: Type.Integer({ minimum: 0 }),
  finalUserWarningSecondsBeforeClaimDeadline: Type.Integer({ minimum: 0 }),
  platformSubsidyStepMinor: Type.Integer({ minimum: 1 }),
  platformSubsidyMaxStepMinor: Type.Integer({ minimum: 1 }),
  platformSubsidyMaxPerOrderMinor: Type.Integer({ minimum: 1 }),
  platformSubsidyMinIntervalSeconds: Type.Integer({ minimum: 0 }),
  merchantSubsidyBudgetMaxUsageBpsPerOrder: Type.Integer({ minimum: 0, maximum: 10_000 }),
  unattendedDeliveryMethods: Type.Array(Type.Enum(DeliveryMethod), { uniqueItems: true }),
  handoffCodeDeliveryMethods: Type.Array(Type.Enum(DeliveryMethod), { uniqueItems: true }),
  requireHandoffCodeForAllOrders: Type.Boolean(),
  exposureThresholds: Type.Array(Type.Object({
    minUsageBps: Type.Integer({ minimum: 0, maximum: 10_000 }),
    state: Type.Enum(MerchantExposureState),
  }), { minItems: 1 }),
}, { additionalProperties: false });

export type PolicyConfig = Static<typeof PolicyConfigSchema>;
export type DeliveryRiskResult = 'NORMAL' | 'REQUIRE_HANDOFF_CODE';

export function validatePolicyPayload(payload: Prisma.JsonValue): PolicyConfig {
  if (!Value.Check(PolicyConfigSchema, payload)) {
    throw new AppError(400, 'INVALID_BUSINESS_CONFIG', 'ORDER_POLICY payload is invalid');
  }
  const config = payload as PolicyConfig;
  if (config.platformSubsidyStepMinor > config.platformSubsidyMaxStepMinor) {
    throw new AppError(400, 'INVALID_BUSINESS_CONFIG', 'Subsidy step cannot exceed the maximum step');
  }
  if (config.platformSubsidyMaxStepMinor > config.platformSubsidyMaxPerOrderMinor) {
    throw new AppError(400, 'INVALID_BUSINESS_CONFIG', 'Maximum subsidy step cannot exceed the per-order cap');
  }
  if (config.finalUserWarningSecondsBeforeClaimDeadline > config.orderClaimWindowSeconds) {
    throw new AppError(400, 'INVALID_BUSINESS_CONFIG', 'Final warning must fit within the claim window');
  }
  const thresholds = [...config.exposureThresholds].sort((a, b) => a.minUsageBps - b.minUsageBps);
  if (thresholds[0]?.minUsageBps !== 0) {
    throw new AppError(400, 'INVALID_BUSINESS_CONFIG', 'Exposure thresholds must start at 0 basis points');
  }
  return { ...config, exposureThresholds: thresholds };
}

export async function loadPolicyConfig(prisma: PrismaClient): Promise<{ version: number; config: PolicyConfig }> {
  const row = await prisma.businessConfig.findFirst({
    where: { key: 'ORDER_POLICY', isActive: true },
    orderBy: { version: 'desc' },
  });
  if (!row) {
    throw new AppError(500, 'INVALID_BUSINESS_CONFIG', 'Active ORDER_POLICY configuration is missing');
  }
  try {
    return { version: row.version, config: validatePolicyPayload(row.payload) };
  } catch (error) {
    if (error instanceof AppError) {
      throw new AppError(500, 'INVALID_BUSINESS_CONFIG', error.message);
    }
    throw error;
  }
}

export function deliveryVerificationFor(
  config: PolicyConfig,
  method: DeliveryMethod,
  risk: DeliveryRiskResult = 'NORMAL',
): DeliveryVerificationMode {
  if (
    risk === 'REQUIRE_HANDOFF_CODE'
    || config.requireHandoffCodeForAllOrders
    || config.handoffCodeDeliveryMethods.includes(method)
  ) {
    return DeliveryVerificationMode.HANDOFF_CODE;
  }
  return DeliveryVerificationMode.DELIVERY_PHOTO;
}

export type MerchantHandoffRiskResult = 'NORMAL' | 'REQUIRE_PHOTO' | 'REQUIRE_PICKUP_CODE';

export function pickupVerificationFor(
  configuredMode: PickupVerificationMode,
  risk: MerchantHandoffRiskResult = 'NORMAL',
): PickupVerificationMode {
  if (risk === 'REQUIRE_PICKUP_CODE') return PickupVerificationMode.PICKUP_CODE;
  if (risk === 'REQUIRE_PHOTO' && configuredMode === PickupVerificationMode.CONFIRMATION) {
    return PickupVerificationMode.PHOTO;
  }
  return configuredMode;
}

export function allowsUnattendedDelivery(config: PolicyConfig, method: DeliveryMethod): boolean {
  return config.unattendedDeliveryMethods.includes(method);
}

export function exposureForUsage(
  usedMinor: number,
  limitMinor: number,
  thresholds: PolicyConfig['exposureThresholds'],
): { state: MerchantExposureState; usageBps: number } {
  assertMinor(usedMinor, 'usedMinor');
  assertMinor(limitMinor, 'limitMinor');
  const usageBps = limitMinor === 0 ? (usedMinor === 0 ? 0 : 10_000) : Math.min(10_000, Math.floor((usedMinor * 10_000) / limitMinor));
  let state = thresholds[0]?.state ?? MerchantExposureState.NORMAL;
  for (const threshold of thresholds) {
    if (usageBps >= threshold.minUsageBps) state = threshold.state;
  }
  return { state, usageBps };
}
