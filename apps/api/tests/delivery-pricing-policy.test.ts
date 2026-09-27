import { FoodType } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import { demoPolicy } from '../prisma/seed.js';
import type { PolicyConfig } from '../src/merchant-policy/policies.js';
import { ConfiguredDeliveryPricingPolicy } from '../src/pricing/policy.js';

describe('configured delivery pricing policy', () => {
  const policy = new ConfiguredDeliveryPricingPolicy();
  const config = demoPolicy as PolicyConfig;
  const input = {
    merchantId: '10000000-0000-4000-8000-000000000001',
    merchantBaseDeliveryPriceMinor: 100,
    merchantCategoryNames: ['主食'],
    pickupRegion: '东门片区',
    destinationRegion: '一期',
    suggestedFoodTypes: [FoodType.RICE_MEAL],
    totalQuantity: 2,
  };

  it('calculates customer fee and rider base independently with a non-negative contribution', () => {
    expect(policy.evaluate(input, config)).toMatchObject({
      customerDeliveryFeeMinor: 320,
      riderBasePayoutMinor: 220,
      deliveryPlatformContributionMinor: 100,
      reason: 'GLOBAL_DEFAULT_WITH_QUANTITY',
    });
  });

  it('uses merchant override and quantity while keeping AI/location/reference inputs reserved', () => {
    const configured = {
      ...config,
      deliveryPricingMerchantOverrides: [{
        merchantId: input.merchantId,
        customerDeliveryFeeMinor: 500,
        riderBasePayoutMinor: 350,
      }],
    };
    const first = policy.evaluate(input, configured);
    const changedReservedInputs = policy.evaluate({
      ...input,
      merchantBaseDeliveryPriceMinor: 999,
      pickupRegion: '西门片区',
      destinationRegion: '二期',
      suggestedFoodTypes: [FoodType.CAKE_DESSERT],
    }, configured);
    expect(first).toMatchObject({ customerDeliveryFeeMinor: 520, riderBasePayoutMinor: 370, deliveryPlatformContributionMinor: 150 });
    expect(changedReservedInputs.customerDeliveryFeeMinor).toBe(first.customerDeliveryFeeMinor);
    expect(changedReservedInputs.riderBasePayoutMinor).toBe(first.riderBasePayoutMinor);
  });
});
