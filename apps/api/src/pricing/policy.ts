import type { FoodType, Prisma } from '@prisma/client';
import type { PolicyConfig } from '../merchant-policy/policies.js';
import { AppError } from '../shared/errors.js';

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
  evaluate(input: DeliveryPricingInput, config: PolicyConfig): DeliveryPricingDecision;
}

export class ConfiguredDeliveryPricingPolicy implements DeliveryPricingPolicy {
  evaluate(input: DeliveryPricingInput, config: PolicyConfig): DeliveryPricingDecision {
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
    if (deliveryPlatformContributionMinor < 0) {
      throw new AppError(500, 'INVALID_DELIVERY_PRICING_POLICY', 'Configured base delivery pricing would create a negative contribution');
    }
    return {
      customerDeliveryFeeMinor,
      riderBasePayoutMinor,
      deliveryPlatformContributionMinor,
      reason: merchantOverride ? 'MERCHANT_OVERRIDE_WITH_QUANTITY' : 'GLOBAL_DEFAULT_WITH_QUANTITY',
      inputsSnapshot: {
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
