import {
  DeliveryMethod,
  DeliveryVerificationMode,
  PickupVerificationMode,
  type Prisma,
  type PrismaClient,
} from '@prisma/client';
import { Type, type Static } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { AppError } from '../shared/errors.js';

export const PolicyConfigSchema = Type.Object({
  customerDeliveryFeeMinor: Type.Integer({ minimum: 0 }),
  platformCommissionBps: Type.Integer({ minimum: 0, maximum: 10_000 }),
  subsidyEnabled: Type.Boolean(),
  coolingOffSeconds: Type.Integer({ minimum: 0 }),
  verificationCodeTtlSeconds: Type.Integer({ minimum: 1 }),
  riderSettlementPendingSeconds: Type.Integer({ minimum: 0 }),
  platformMaxConcurrentOrdersPerRider: Type.Integer({ minimum: 1 }),
  customerUnreachableWaitSeconds: Type.Integer({ minimum: 0 }),
  riderTipWindowSeconds: Type.Integer({ minimum: 1 }),
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
  merchantRiskWindowOrderCount: Type.Integer({ minimum: 1, maximum: 1000 }),
  merchantRiskMinimumSampleSize: Type.Integer({ minimum: 1, maximum: 1000 }),
  slowFulfillmentThresholdSeconds: Type.Integer({ minimum: 1 }),
  completionRiskElevatedThresholdBps: Type.Integer({ minimum: 0, maximum: 10_000 }),
  completionRiskHighThresholdBps: Type.Integer({ minimum: 0, maximum: 10_000 }),
  exposureReducedThresholdBps: Type.Integer({ minimum: 0, maximum: 10_000 }),
  exposureLimitedThresholdBps: Type.Integer({ minimum: 0, maximum: 10_000 }),
  exposureSeverelyLimitedThresholdBps: Type.Integer({ minimum: 0, maximum: 10_000 }),
  exposureNormalRecoveryThresholdBps: Type.Integer({ minimum: 0, maximum: 10_000 }),
  exposureReducedRecoveryThresholdBps: Type.Integer({ minimum: 0, maximum: 10_000 }),
  exposureLimitedRecoveryThresholdBps: Type.Integer({ minimum: 0, maximum: 10_000 }),
  subsidyDependencyThresholdBps: Type.Integer({ minimum: 0, maximum: 10_000 }),
  subsidyRescueThresholdBps: Type.Integer({ minimum: 0, maximum: 10_000 }),
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
  if (config.merchantRiskMinimumSampleSize > config.merchantRiskWindowOrderCount) {
    throw new AppError(400, 'INVALID_BUSINESS_CONFIG', 'Risk minimum sample size cannot exceed the order window');
  }
  if (config.completionRiskElevatedThresholdBps > config.completionRiskHighThresholdBps) {
    throw new AppError(400, 'INVALID_BUSINESS_CONFIG', 'Completion risk thresholds must be ordered');
  }
  if (
    config.exposureReducedThresholdBps > config.exposureLimitedThresholdBps
    || config.exposureLimitedThresholdBps > config.exposureSeverelyLimitedThresholdBps
  ) {
    throw new AppError(400, 'INVALID_BUSINESS_CONFIG', 'Exposure downgrade thresholds must be ordered');
  }
  if (
    config.exposureNormalRecoveryThresholdBps >= config.exposureReducedThresholdBps
    || config.exposureReducedRecoveryThresholdBps >= config.exposureLimitedThresholdBps
    || config.exposureLimitedRecoveryThresholdBps >= config.exposureSeverelyLimitedThresholdBps
  ) {
    throw new AppError(400, 'INVALID_BUSINESS_CONFIG', 'Exposure recovery thresholds must remain below their entry thresholds');
  }
  return config;
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
