import type { FoodType, Prisma } from '@prisma/client';
import type { PolicyConfig } from '../merchant-policy/policies.js';
import { AppError } from '../shared/errors.js';
import { assertStoredMinor, type VersionedDeliveryPricingConfig } from './config.js';

export type DeliveryPricingInput = {
  merchantId: string;
  merchantBaseDeliveryPriceMinor: number;
  merchantCategoryNames: string[];
  pickupRegion: string | null;
  destinationRegion: string | null;
  suggestedFoodTypes: FoodType[];
  totalQuantity: number;
};

export type DeliveryPricingDecision = {
  customerDeliveryFeeMinor: number;
  riderBasePayoutMinor: number;
  deliveryPlatformContributionMinor: number;
  reason: string;
  inputsSnapshot: Prisma.InputJsonValue;
};

export interface DeliveryPricingPolicy {
  evaluate(input: DeliveryPricingInput, config: PolicyConfig, pricingConfig?: VersionedDeliveryPricingConfig): DeliveryPricingDecision;
}

export class ConfiguredDeliveryPricingPolicy implements DeliveryPricingPolicy {
  evaluate(input: DeliveryPricingInput, config: PolicyConfig, pricingConfig?: VersionedDeliveryPricingConfig): DeliveryPricingDecision {
    const reference = pricingConfig?.config;
    if (reference?.mode === 'REFERENCE_BPS') {
      const base = assertStoredMinor(input.merchantBaseDeliveryPriceMinor);
      if (base > reference.maxMerchantBaseMinor) {
        throw new AppError(409, 'MERCHANT_QUOTE_OUT_OF_RANGE', 'Merchant reference quote exceeds the configured safety limit');
      }
      // Integer arithmetic is exact even at the storage ceiling. No minimum is invented.
      const markup = Number(BigInt(base) * BigInt(reference.customerMarkupBps) / 10_000n);
      const deduction = Number(BigInt(base) * BigInt(reference.riderDeductionBps) / 10_000n);
      const customerDeliveryFeeMinor = assertStoredMinor(base + markup);
      const riderBasePayoutMinor = assertStoredMinor(base - deduction);
      const spread = customerDeliveryFeeMinor - riderBasePayoutMinor;
      return {
        customerDeliveryFeeMinor,
        riderBasePayoutMinor,
        deliveryPlatformContributionMinor: spread,
        reason: 'MERCHANT_REFERENCE_BPS',
        inputsSnapshot: {
          ...input,
          mode: reference.mode,
          deliveryPricingPolicyVersion: pricingConfig?.version ?? 0,
          customerMarkupBps: reference.customerMarkupBps,
          riderDeductionBps: reference.riderDeductionBps,
          rounding: reference.rounding,
          maxMerchantBaseMinor: reference.maxMerchantBaseMinor,
          customerMarkupMinor: markup,
          riderDeductionMinor: deduction,
          basePlatformSpreadMinor: spread,
          activeInputs: ['merchantBaseDeliveryPriceMinor'],
          reservedInputs: ['merchantId', 'merchantCategoryNames', 'pickupRegion', 'destinationRegion', 'suggestedFoodTypes', 'totalQuantity'],
        },
      };
    }
    const merchantOverride = config.deliveryPricingMerchantOverrides.find(
      (override) => override.merchantId === input.merchantId,
    );
    const additionalItems = Math.max(0, input.totalQuantity - 1);
    const customerDeliveryFeeMinor = (merchantOverride?.customerDeliveryFeeMinor
      ?? config.deliveryPricingDefaultCustomerFeeMinor)
      + additionalItems * config.deliveryPricingAdditionalItemCustomerFeeMinor;
    const riderBasePayoutMinor = (merchantOverride?.riderBasePayoutMinor
      ?? config.deliveryPricingDefaultRiderBasePayoutMinor)
      + additionalItems * config.deliveryPricingAdditionalItemRiderPayoutMinor;
    const deliveryPlatformContributionMinor = customerDeliveryFeeMinor - riderBasePayoutMinor;
    assertStoredMinor(customerDeliveryFeeMinor);
    assertStoredMinor(riderBasePayoutMinor);
    if (deliveryPlatformContributionMinor < 0) {
      throw new AppError(500, 'INVALID_DELIVERY_PRICING_POLICY', 'Configured base delivery pricing would create a negative contribution');
    }
    return {
      customerDeliveryFeeMinor,
      riderBasePayoutMinor,
      deliveryPlatformContributionMinor,
      reason: merchantOverride ? 'MERCHANT_OVERRIDE_WITH_QUANTITY' : 'GLOBAL_DEFAULT_WITH_QUANTITY',
      inputsSnapshot: {
        mode: 'LEGACY_ORDER_POLICY',
        deliveryPricingPolicyVersion: pricingConfig?.version ?? 0,
        merchantId: input.merchantId,
        merchantBaseDeliveryPriceMinor: input.merchantBaseDeliveryPriceMinor,
        merchantCategoryNames: input.merchantCategoryNames,
        pickupRegion: input.pickupRegion,
        destinationRegion: input.destinationRegion,
        suggestedFoodTypes: input.suggestedFoodTypes,
        totalQuantity: input.totalQuantity,
        activeInputs: ['merchantId', 'totalQuantity'],
        reservedInputs: ['merchantBaseDeliveryPriceMinor', 'merchantCategoryNames', 'pickupRegion', 'destinationRegion', 'suggestedFoodTypes'],
      },
    };
  }
}

export const defaultDeliveryPricingPolicy: DeliveryPricingPolicy = new ConfiguredDeliveryPricingPolicy();
