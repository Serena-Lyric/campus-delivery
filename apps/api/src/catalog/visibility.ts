import { createHash } from 'node:crypto';
import { MerchantExposureState } from '@prisma/client';

export function stableExposureBucket(merchantId: string, customerId: string): number {
  return createHash('sha256').update(`${merchantId}:${customerId}`).digest().readUInt32BE(0) % 10_000;
}

export function isMerchantVisibleToCustomer(input: {
  merchantId: string;
  customerId: string;
  exposureState: MerchantExposureState;
  trialExposureOverrideBps: number | null;
  configuredTrialExposureBps: number;
}): boolean {
  if (
    input.exposureState === MerchantExposureState.HIDDEN
    || input.exposureState === MerchantExposureState.SUSPENDED
  ) return false;
  if (input.exposureState !== MerchantExposureState.TRIAL) return true;
  const exposureBps = input.trialExposureOverrideBps ?? input.configuredTrialExposureBps;
  return stableExposureBucket(input.merchantId, input.customerId) < exposureBps;
}
