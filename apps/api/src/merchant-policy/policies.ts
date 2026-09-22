import {
  DeliveryMethod,
  DeliveryVerificationMode,
  MerchantExposureState,
  PickupVerificationMode,
  type PrismaClient,
} from '@prisma/client';
import { Type, type Static } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { AppError } from '../shared/errors.js';
import { assertMinor } from '../shared/money.js';

const PolicyConfigSchema = Type.Object({
  customerDeliveryFeeMinor: Type.Integer({ minimum: 0 }),
  targetRiderPayoutMinor: Type.Integer({ minimum: 0 }),
  maxSubsidyPerOrderMinor: Type.Integer({ minimum: 0 }),
  platformCommissionBps: Type.Integer({ minimum: 0, maximum: 10_000 }),
  subsidyEnabled: Type.Boolean(),
  coolingOffSeconds: Type.Integer({ minimum: 0 }),
  verificationCodeTtlSeconds: Type.Integer({ minimum: 1 }),
  riderSettlementPendingSeconds: Type.Integer({ minimum: 0 }),
  platformMaxConcurrentOrdersPerRider: Type.Integer({ minimum: 1 }),
  customerUnreachableWaitSeconds: Type.Integer({ minimum: 0 }),
  unattendedDeliveryMethods: Type.Array(Type.Enum(DeliveryMethod), { uniqueItems: true }),
  handoffCodeDeliveryMethods: Type.Array(Type.Enum(DeliveryMethod), { uniqueItems: true }),
  requireHandoffCodeForAllOrders: Type.Boolean(),
  exposureThresholds: Type.Array(Type.Object({
    minUsageBps: Type.Integer({ minimum: 0, maximum: 10_000 }),
    state: Type.Enum(MerchantExposureState),
  }), { minItems: 1 }),
});

export type PolicyConfig = Static<typeof PolicyConfigSchema>;
export type DeliveryRiskResult = 'NORMAL' | 'REQUIRE_HANDOFF_CODE';

export async function loadPolicyConfig(prisma: PrismaClient): Promise<{ version: number; config: PolicyConfig }> {
  const row = await prisma.businessConfig.findFirst({
    where: { key: 'ORDER_POLICY', isActive: true },
    orderBy: { version: 'desc' },
  });
  if (!row || !Value.Check(PolicyConfigSchema, row.payload)) {
    throw new AppError(500, 'INVALID_BUSINESS_CONFIG', 'Active ORDER_POLICY configuration is missing or invalid');
  }
  const config = row.payload as PolicyConfig;
  const thresholds = [...config.exposureThresholds].sort((a, b) => a.minUsageBps - b.minUsageBps);
  if (thresholds[0]?.minUsageBps !== 0) {
    throw new AppError(500, 'INVALID_BUSINESS_CONFIG', 'Exposure thresholds must start at 0 basis points');
  }
  return { version: row.version, config: { ...config, exposureThresholds: thresholds } };
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

export function calculateSubsidy(input: {
  enabled: boolean;
  targetRiderPayoutMinor: number;
  customerDeliveryFeeMinor: number;
  merchantContributionMinor: number;
  maxSubsidyPerOrderMinor: number;
  remainingSubsidyMinor: number;
}): number {
  Object.entries(input).forEach(([key, value]) => key === 'enabled' || assertMinor(value as number, key));
  if (!input.enabled) return 0;
  const gap = Math.max(0, input.targetRiderPayoutMinor - input.customerDeliveryFeeMinor - input.merchantContributionMinor);
  return Math.min(gap, input.maxSubsidyPerOrderMinor, input.remainingSubsidyMinor);
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
