-- CreateEnum
CREATE TYPE "MerchantTimeRisk" AS ENUM ('UNKNOWN', 'NORMAL', 'SLOW');

-- CreateEnum
CREATE TYPE "MerchantCompletionRisk" AS ENUM ('UNKNOWN', 'NORMAL', 'ELEVATED', 'HIGH');

-- AlterTable
ALTER TABLE "Merchant" ALTER COLUMN "exposureState" SET DEFAULT 'TRIAL';

-- AlterTable: snapshot the rider-tip window for existing and future orders.
ALTER TABLE "Order" ADD COLUMN "tipDeadline" TIMESTAMP(3);
UPDATE "Order" SET "tipDeadline" = "createdAt" + INTERVAL '24 hours';
ALTER TABLE "Order" ALTER COLUMN "tipDeadline" SET NOT NULL;

-- Rename the factual subsidy-usage value so it is not presented as a risk score.
ALTER TABLE "MerchantSubsidyAccount" RENAME COLUMN "riskScore" TO "subsidyUsageBps";
ALTER TABLE "MerchantSubsidyAccount" DROP CONSTRAINT "MerchantSubsidyAccount_values_check";
ALTER TABLE "MerchantSubsidyAccount" ADD CONSTRAINT "MerchantSubsidyAccount_values_check" CHECK (
  "subsidyUsedMinor" >= 0 AND "subsidyLimitMinor" >= 0 AND "subsidyUsageBps" BETWEEN 0 AND 10000
);

-- CreateTable
CREATE TABLE "MerchantExposureDecision" (
    "id" UUID NOT NULL,
    "merchantId" UUID NOT NULL,
    "previousState" "MerchantExposureState" NOT NULL,
    "newState" "MerchantExposureState" NOT NULL,
    "timeRisk" "MerchantTimeRisk" NOT NULL,
    "completionRisk" "MerchantCompletionRisk" NOT NULL,
    "policyVersion" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "metricsSnapshot" JSONB NOT NULL,
    "actorId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MerchantExposureDecision_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "MerchantExposureDecision_merchantId_createdAt_idx" ON "MerchantExposureDecision"("merchantId", "createdAt");

ALTER TABLE "MerchantExposureDecision" ADD CONSTRAINT "MerchantExposureDecision_merchantId_fkey"
  FOREIGN KEY ("merchantId") REFERENCES "Merchant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MerchantExposureDecision" ADD CONSTRAINT "MerchantExposureDecision_actorId_fkey"
  FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "MerchantExposureDecision" ADD CONSTRAINT "MerchantExposureDecision_policyVersion_check"
  CHECK ("policyVersion" > 0);

-- Replace the legacy subsidy-usage exposure thresholds with provisional, versioned risk controls.
UPDATE "BusinessConfig"
SET "payload" = ("payload" - 'exposureThresholds') || jsonb_build_object(
  'riderTipWindowSeconds', 86400,
  'merchantRiskWindowOrderCount', 50,
  'merchantRiskMinimumSampleSize', 10,
  'slowFulfillmentThresholdSeconds', 2700,
  'completionRiskElevatedThresholdBps', 1500,
  'completionRiskHighThresholdBps', 3000,
  'exposureReducedThresholdBps', 1500,
  'exposureLimitedThresholdBps', 3000,
  'exposureSeverelyLimitedThresholdBps', 5000,
  'exposureNormalRecoveryThresholdBps', 800,
  'exposureReducedRecoveryThresholdBps', 2000,
  'exposureLimitedRecoveryThresholdBps', 3500,
  'subsidyDependencyThresholdBps', 5000,
  'subsidyRescueThresholdBps', 5000
)
WHERE "key" = 'ORDER_POLICY';
