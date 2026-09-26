import { MerchantExposureState } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import { isMerchantVisibleToCustomer, stableExposureBucket } from '../src/catalog/visibility.js';

describe('trial merchant exposure', () => {
  const merchantId = '10000000-0000-4000-8000-000000000001';

  it('assigns a stable deterministic bucket and permits different customer outcomes', () => {
    const customers = Array.from({ length: 100 }, (_, index) => `customer-${index}`);
    const visible = customers.find((customerId) => stableExposureBucket(merchantId, customerId) < 2500)!;
    const hidden = customers.find((customerId) => stableExposureBucket(merchantId, customerId) >= 2500)!;
    expect(stableExposureBucket(merchantId, visible)).toBe(stableExposureBucket(merchantId, visible));
    expect(isMerchantVisibleToCustomer({
      merchantId,
      customerId: visible,
      exposureState: MerchantExposureState.TRIAL,
      trialExposureOverrideBps: null,
      configuredTrialExposureBps: 2500,
    })).toBe(true);
    expect(isMerchantVisibleToCustomer({
      merchantId,
      customerId: hidden,
      exposureState: MerchantExposureState.TRIAL,
      trialExposureOverrideBps: null,
      configuredTrialExposureBps: 2500,
    })).toBe(false);
  });

  it('honors explicit seed override and always hides hidden merchants', () => {
    expect(isMerchantVisibleToCustomer({
      merchantId,
      customerId: 'customer',
      exposureState: MerchantExposureState.TRIAL,
      trialExposureOverrideBps: 10_000,
      configuredTrialExposureBps: 0,
    })).toBe(true);
    expect(isMerchantVisibleToCustomer({
      merchantId,
      customerId: 'customer',
      exposureState: MerchantExposureState.HIDDEN,
      trialExposureOverrideBps: 10_000,
      configuredTrialExposureBps: 10_000,
    })).toBe(false);
  });
});
