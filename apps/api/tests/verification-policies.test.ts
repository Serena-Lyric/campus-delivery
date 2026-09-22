import { DeliveryMethod, DeliveryVerificationMode, PickupVerificationMode } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import { demoPolicy } from '../prisma/seed.js';
import {
  deliveryVerificationFor,
  pickupVerificationFor,
  type PolicyConfig,
} from '../src/merchant-policy/policies.js';

describe('handoff policy extension points', () => {
  const config = demoPolicy as PolicyConfig;

  it('derives normal delivery verification from configuration and can force a handoff code', () => {
    expect(deliveryVerificationFor(config, DeliveryMethod.DESIGNATED_POINT)).toBe(DeliveryVerificationMode.DELIVERY_PHOTO);
    expect(deliveryVerificationFor(config, DeliveryMethod.DESIGNATED_POINT, 'REQUIRE_HANDOFF_CODE')).toBe(DeliveryVerificationMode.HANDOFF_CODE);
  });

  it('strengthens merchant pickup verification without scoring the merchant', () => {
    expect(pickupVerificationFor(PickupVerificationMode.CONFIRMATION)).toBe(PickupVerificationMode.CONFIRMATION);
    expect(pickupVerificationFor(PickupVerificationMode.CONFIRMATION, 'REQUIRE_PHOTO')).toBe(PickupVerificationMode.PHOTO);
    expect(pickupVerificationFor(PickupVerificationMode.PHOTO, 'REQUIRE_PICKUP_CODE')).toBe(PickupVerificationMode.PICKUP_CODE);
  });
});
