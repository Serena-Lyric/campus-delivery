import { PickupEvidenceLevel } from '@prisma/client';
import type { PolicyConfig } from '../merchant-policy/policies.js';
import { badRequest } from '../shared/errors.js';

// Technical baseline: undiscounted sold unit-price snapshots; no coupon/tip/subsidy allocation.
export function pickupRiskSnapshot(
  items: readonly { coreFragileSnapshot: boolean; unitPriceMinor: number; quantity: number }[],
  config: Pick<PolicyConfig, 'fragilePickupRecommendedMinor' | 'fragilePickupRequiredMinor'>,
  version: number,
) {
  const value = items.reduce((sum, item) => sum + (item.coreFragileSnapshot ? item.unitPriceMinor * item.quantity : 0), 0);
  if (!Number.isSafeInteger(value) || value < 0 || value > 2147483647) throw badRequest('MONEY_OVERFLOW', 'Fragile value exceeds minor-unit storage range');
  const recommended = config.fragilePickupRecommendedMinor ?? 1500;
  const required = config.fragilePickupRequiredMinor ?? 5000;
  return {
    coreFragileValueMinor: value,
    pickupEvidenceLevel: value > required ? PickupEvidenceLevel.REQUIRED : value > recommended ? PickupEvidenceLevel.RECOMMENDED : PickupEvidenceLevel.NONE,
    pickupEvidencePolicyVersion: version,
    pickupEvidenceRecommendedMinor: recommended,
    pickupEvidenceRequiredMinor: required,
  };
}
