import { FoodType } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import { demoPolicy } from '../prisma/seed.js';
import type { PolicyConfig } from '../src/merchant-policy/policies.js';
import { ConfiguredDeliveryPricingPolicy } from '../src/pricing/policy.js';
import { validateDeliveryPricingConfig, type VersionedDeliveryPricingConfig } from '../src/pricing/config.js';

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

  const reference: VersionedDeliveryPricingConfig = {
    version: 3,
    config: { mode: 'REFERENCE_BPS', customerMarkupBps: 2000, riderDeductionBps: 2000, rounding: 'FLOOR_ADJUSTMENTS', maxMerchantBaseMinor: 1_073_741_823 },
  };

  it('uses B alone in reference mode without stacking legacy fees, overrides or quantity charges', () => {
    const decision = policy.evaluate({ ...input, merchantBaseDeliveryPriceMinor: 250 }, config, reference);
    expect(decision).toMatchObject({ customerDeliveryFeeMinor: 300, riderBasePayoutMinor: 200, deliveryPlatformContributionMinor: 100 });
    expect(decision.inputsSnapshot).toMatchObject({ mode: 'REFERENCE_BPS', deliveryPricingPolicyVersion: 3, customerMarkupBps: 2000, riderDeductionBps: 2000, basePlatformSpreadMinor: 100, rounding: 'FLOOR_ADJUSTMENTS' });
    expect(policy.evaluate({ ...input, totalQuantity: 99, merchantBaseDeliveryPriceMinor: 250 }, config, reference)).toMatchObject({ customerDeliveryFeeMinor: 300, riderBasePayoutMinor: 200 });
  });

  it('changes the two sides independently and leaves legacy mode explicit', () => {
    if (reference.config.mode !== 'REFERENCE_BPS') throw new Error('fixture');
    expect(policy.evaluate({ ...input, merchantBaseDeliveryPriceMinor: 250 }, config, { ...reference, config: { ...reference.config, customerMarkupBps: 4000 } })).toMatchObject({ customerDeliveryFeeMinor: 350, riderBasePayoutMinor: 200 });
    expect(policy.evaluate({ ...input, merchantBaseDeliveryPriceMinor: 250 }, config, { ...reference, config: { ...reference.config, riderDeductionBps: 4000 } })).toMatchObject({ customerDeliveryFeeMinor: 300, riderBasePayoutMinor: 150 });
    expect(policy.evaluate(input, config, { version: 4, config: { mode: 'LEGACY_ORDER_POLICY' } })).toMatchObject({ customerDeliveryFeeMinor: 320, riderBasePayoutMinor: 220 });
  });

  it('handles zero, tiny, maximum and invalid amounts with exact floor adjustments and no invented minimum', () => {
    expect(policy.evaluate({ ...input, merchantBaseDeliveryPriceMinor: 0 }, config, reference)).toMatchObject({ customerDeliveryFeeMinor: 0, riderBasePayoutMinor: 0 });
    expect(policy.evaluate({ ...input, merchantBaseDeliveryPriceMinor: 1 }, config, reference)).toMatchObject({ customerDeliveryFeeMinor: 1, riderBasePayoutMinor: 1 });
    if (reference.config.mode !== 'REFERENCE_BPS') throw new Error('fixture');
    const full = { ...reference, config: { ...reference.config, customerMarkupBps: 10000, riderDeductionBps: 10000 } };
    expect(policy.evaluate({ ...input, merchantBaseDeliveryPriceMinor: 1_073_741_823 }, config, full)).toMatchObject({ customerDeliveryFeeMinor: 2_147_483_646, riderBasePayoutMinor: 0 });
    for (const value of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER]) {
      expect(() => policy.evaluate({ ...input, merchantBaseDeliveryPriceMinor: value }, config, reference)).toThrow();
    }
    expect(() => policy.evaluate({ ...input, merchantBaseDeliveryPriceMinor: 1_073_741_824 }, config, reference)).toThrow();
  });

  it('requires explicit independently bounded rates, rounding and cap, with no implicit commercial default', () => {
    expect(validateDeliveryPricingConfig({ mode: 'LEGACY_ORDER_POLICY' })).toEqual({ mode: 'LEGACY_ORDER_POLICY' });
    if (reference.config.mode !== 'REFERENCE_BPS') throw new Error('fixture');
    for (const change of [{ customerMarkupBps: -1 }, { riderDeductionBps: 10001 }, { customerMarkupBps: 1.5 }, { rounding: 'UNKNOWN' }, { maxMerchantBaseMinor: 2_147_483_647 }]) {
      expect(() => validateDeliveryPricingConfig({ ...reference.config, ...change })).toThrow();
    }
    expect(() => validateDeliveryPricingConfig({ mode: 'REFERENCE_BPS' })).toThrow();
  });
});
