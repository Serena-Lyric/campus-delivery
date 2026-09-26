-- AlterTable
ALTER TABLE "Merchant" ADD COLUMN "trialExposureOverrideBps" INTEGER;
ALTER TABLE "Merchant" ADD CONSTRAINT "Merchant_trial_exposure_override_check"
  CHECK ("trialExposureOverrideBps" IS NULL OR "trialExposureOverrideBps" BETWEEN 0 AND 10000);

-- Extend every historical ORDER_POLICY version so it remains valid under the strict schema.
UPDATE "BusinessConfig"
SET "payload" = "payload" || jsonb_build_object(
  'merchantTrialExposureBps', 2500,
  'merchantExposureRecoveryMinimumSampleSize', 10,
  'merchantExposureRecoveryWindowOrderCount', 20
)
WHERE "key" = 'ORDER_POLICY';
