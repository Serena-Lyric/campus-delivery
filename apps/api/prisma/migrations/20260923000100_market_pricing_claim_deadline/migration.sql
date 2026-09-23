-- CreateEnum
CREATE TYPE "MerchantPreparationStatus" AS ENUM ('PREPARING', 'READY_FOR_PICKUP');

-- CreateEnum
CREATE TYPE "ClaimSampleType" AS ENUM ('NATURAL', 'SUBSIDIZED');

-- CreateEnum
CREATE TYPE "RiderTipEventType" AS ENUM ('PRE_CLAIM_ADJUSTMENT', 'POST_CLAIM_ADDITION', 'NO_RIDER_REFUND');

-- AlterEnum
ALTER TYPE "DeliveryTaskStatus" ADD VALUE 'NO_RIDER_ACCEPTED';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "OrderEventType" ADD VALUE 'MERCHANT_QUOTE_UPDATED';
ALTER TYPE "OrderEventType" ADD VALUE 'RIDER_TIP_UPDATED';
ALTER TYPE "OrderEventType" ADD VALUE 'PLATFORM_SUBSIDY_ADDED';
ALTER TYPE "OrderEventType" ADD VALUE 'MERCHANT_PREPARATION_UPDATED';
ALTER TYPE "OrderEventType" ADD VALUE 'NO_RIDER_ACCEPTED';

-- AlterEnum
ALTER TYPE "OrderStatus" ADD VALUE 'NO_RIDER_ACCEPTED';

-- DropIndex
DROP INDEX "SubsidyRecord_orderId_key";

-- AlterTable
ALTER TABLE "DeliveryTask" ADD COLUMN     "claimDeadline" TIMESTAMP(3),
ADD COLUMN     "firstPublishedAt" TIMESTAMP(3);

UPDATE "DeliveryTask"
SET "firstPublishedAt" = COALESCE("claimedAt", "createdAt"),
    "claimDeadline" = COALESCE("claimedAt", "createdAt") + INTERVAL '40 minutes'
WHERE "firstPublishedAt" IS NULL;

-- Add compatibility defaults before backfilling existing assignments.
ALTER TABLE "DeliveryAssignment" ADD COLUMN     "claimLatencySeconds" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "claimSampleType" "ClaimSampleType" NOT NULL DEFAULT 'NATURAL',
ADD COLUMN     "customerTipMinorAtClaim" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "merchantQuoteMinorAtClaim" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "platformSubsidyMinorAtClaim" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "postClaimTipMinor" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "quoteVersionAtClaim" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "riderPayoutMinorAtClaim" INTEGER NOT NULL DEFAULT 0;

UPDATE "DeliveryAssignment" assignment
SET "merchantQuoteMinorAtClaim" = pricing."merchantDeliveryContributionMinor",
    "platformSubsidyMinorAtClaim" = pricing."platformSubsidyMinor",
    "riderPayoutMinorAtClaim" = pricing."riderPayoutMinor",
    "quoteVersionAtClaim" = CASE WHEN pricing."merchantDeliveryContributionMinor" >= 0 THEN 1 ELSE 0 END,
    "claimSampleType" = CASE
      WHEN pricing."platformSubsidyMinor" > 0 THEN 'SUBSIDIZED'::"ClaimSampleType"
      ELSE 'NATURAL'::"ClaimSampleType"
    END,
    "claimLatencySeconds" = GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (assignment."claimedAt" - task."firstPublishedAt")))::integer)
FROM "OrderPricing" pricing, "DeliveryTask" task
WHERE assignment."orderId" = pricing."orderId"
  AND assignment."taskId" = task."id";

ALTER TABLE "DeliveryAssignment"
ALTER COLUMN "claimLatencySeconds" DROP DEFAULT,
ALTER COLUMN "claimSampleType" DROP DEFAULT,
ALTER COLUMN "customerTipMinorAtClaim" DROP DEFAULT,
ALTER COLUMN "merchantQuoteMinorAtClaim" DROP DEFAULT,
ALTER COLUMN "platformSubsidyMinorAtClaim" DROP DEFAULT,
ALTER COLUMN "quoteVersionAtClaim" DROP DEFAULT,
ALTER COLUMN "riderPayoutMinorAtClaim" DROP DEFAULT;

-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "deliveryEvidenceRequired" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "merchantPreparationStatus" "MerchantPreparationStatus" NOT NULL DEFAULT 'PREPARING',
ADD COLUMN     "merchantPreparationUpdatedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "OrderPricing" ADD COLUMN     "customerRiderTipMinor" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "customerRiderTipRefundMinor" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "merchantQuoteUpdatedAt" TIMESTAMP(3),
ADD COLUMN     "merchantQuoteVersion" INTEGER NOT NULL DEFAULT 0;

-- AlterTable: preserve legacy subsidy amounts as the first immutable increment.
ALTER TABLE "SubsidyRecord" RENAME COLUMN "amountMinor" TO "addedMinor";
ALTER TABLE "SubsidyRecord"
ADD COLUMN     "newPlatformSubsidyMinor" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "previousPlatformSubsidyMinor" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "trigger" TEXT NOT NULL DEFAULT 'LEGACY_MIGRATION';

UPDATE "SubsidyRecord"
SET "newPlatformSubsidyMinor" = "addedMinor";

ALTER TABLE "SubsidyRecord"
ALTER COLUMN "newPlatformSubsidyMinor" DROP DEFAULT,
ALTER COLUMN "previousPlatformSubsidyMinor" DROP DEFAULT,
ALTER COLUMN "trigger" DROP DEFAULT;

-- CreateTable
CREATE TABLE "MerchantDeliveryQuote" (
    "id" UUID NOT NULL,
    "orderId" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "previousMinor" INTEGER NOT NULL,
    "newMinor" INTEGER NOT NULL,
    "operatorId" UUID NOT NULL,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MerchantDeliveryQuote_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RiderTipEvent" (
    "id" UUID NOT NULL,
    "orderId" UUID NOT NULL,
    "customerId" UUID NOT NULL,
    "deliveryAssignmentId" UUID,
    "type" "RiderTipEventType" NOT NULL,
    "deltaMinor" INTEGER NOT NULL,
    "balanceAfterMinor" INTEGER NOT NULL,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RiderTipEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BusinessConfigAudit" (
    "id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "previousVersion" INTEGER,
    "newVersion" INTEGER NOT NULL,
    "actorId" UUID NOT NULL,
    "beforePayload" JSONB,
    "afterPayload" JSONB NOT NULL,
    "reason" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BusinessConfigAudit_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MerchantDeliveryQuote_orderId_createdAt_idx" ON "MerchantDeliveryQuote"("orderId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "MerchantDeliveryQuote_orderId_version_key" ON "MerchantDeliveryQuote"("orderId", "version");

-- CreateIndex
CREATE INDEX "RiderTipEvent_orderId_createdAt_idx" ON "RiderTipEvent"("orderId", "createdAt");

-- CreateIndex
CREATE INDEX "RiderTipEvent_deliveryAssignmentId_idx" ON "RiderTipEvent"("deliveryAssignmentId");

-- CreateIndex
CREATE INDEX "BusinessConfigAudit_key_createdAt_idx" ON "BusinessConfigAudit"("key", "createdAt");

-- CreateIndex
CREATE INDEX "SubsidyRecord_orderId_createdAt_idx" ON "SubsidyRecord"("orderId", "createdAt");

-- AddForeignKey
ALTER TABLE "MerchantDeliveryQuote" ADD CONSTRAINT "MerchantDeliveryQuote_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MerchantDeliveryQuote" ADD CONSTRAINT "MerchantDeliveryQuote_operatorId_fkey" FOREIGN KEY ("operatorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RiderTipEvent" ADD CONSTRAINT "RiderTipEvent_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RiderTipEvent" ADD CONSTRAINT "RiderTipEvent_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RiderTipEvent" ADD CONSTRAINT "RiderTipEvent_deliveryAssignmentId_fkey" FOREIGN KEY ("deliveryAssignmentId") REFERENCES "DeliveryAssignment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BusinessConfigAudit" ADD CONSTRAINT "BusinessConfigAudit_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Value and snapshot consistency constraints.
ALTER TABLE "DeliveryTask" ADD CONSTRAINT "DeliveryTask_claim_window_check"
  CHECK ("firstPublishedAt" IS NULL OR "claimDeadline" IS NULL OR "claimDeadline" >= "firstPublishedAt");
ALTER TABLE "DeliveryAssignment" ADD CONSTRAINT "DeliveryAssignment_pricing_snapshot_check"
  CHECK (
    "merchantQuoteMinorAtClaim" >= 0 AND
    "customerTipMinorAtClaim" >= 0 AND
    "platformSubsidyMinorAtClaim" >= 0 AND
    "riderPayoutMinorAtClaim" >= 0 AND
    "postClaimTipMinor" >= 0 AND
    "quoteVersionAtClaim" >= 0 AND
    "claimLatencySeconds" >= 0
  );
ALTER TABLE "OrderPricing" ADD CONSTRAINT "OrderPricing_market_amounts_check"
  CHECK (
    "customerRiderTipMinor" >= 0 AND
    "customerRiderTipRefundMinor" >= 0 AND
    "merchantQuoteVersion" >= 0
  );
ALTER TABLE "MerchantDeliveryQuote" ADD CONSTRAINT "MerchantDeliveryQuote_values_check"
  CHECK ("version" > 0 AND "previousMinor" >= 0 AND "newMinor" >= 0);
ALTER TABLE "RiderTipEvent" ADD CONSTRAINT "RiderTipEvent_balance_check"
  CHECK ("balanceAfterMinor" >= 0);
ALTER TABLE "SubsidyRecord" ADD CONSTRAINT "SubsidyRecord_increment_check"
  CHECK (
    "previousPlatformSubsidyMinor" >= 0 AND
    "addedMinor" > 0 AND
    "newPlatformSubsidyMinor" = "previousPlatformSubsidyMinor" + "addedMinor"
  );
ALTER TABLE "BusinessConfigAudit" ADD CONSTRAINT "BusinessConfigAudit_version_check"
  CHECK ("newVersion" > 0 AND ("previousVersion" IS NULL OR "previousVersion" > 0));

-- Existing published orders receive an initial quote version and immutable history.
UPDATE "OrderPricing" pricing
SET "merchantQuoteVersion" = 1,
    "merchantQuoteUpdatedAt" = COALESCE(pricing."updatedAt", CURRENT_TIMESTAMP)
FROM "Order" orders
WHERE pricing."orderId" = orders."id"
  AND orders."status" NOT IN ('CREATED', 'MERCHANT_PENDING');

INSERT INTO "MerchantDeliveryQuote" (
  "id", "orderId", "version", "previousMinor", "newMinor", "operatorId", "reason", "createdAt"
)
SELECT
  md5(random()::text || clock_timestamp()::text)::uuid,
  orders."id",
  1,
  0,
  pricing."merchantDeliveryContributionMinor",
  merchant."ownerId",
  'LEGACY_MIGRATION',
  COALESCE(pricing."merchantQuoteUpdatedAt", orders."updatedAt")
FROM "Order" orders
JOIN "OrderPricing" pricing ON pricing."orderId" = orders."id"
JOIN "Merchant" merchant ON merchant."id" = orders."merchantId"
WHERE pricing."merchantQuoteVersion" = 1
ON CONFLICT ("orderId", "version") DO NOTHING;

-- Existing merchant-confirmed orders are published without inventing a new deadline on later re-entry.
INSERT INTO "DeliveryTask" (
  "id", "orderId", "status", "payoutMinor", "firstPublishedAt", "claimDeadline", "createdAt", "updatedAt"
)
SELECT
  md5(random()::text || clock_timestamp()::text)::uuid,
  orders."id",
  'OPEN'::"DeliveryTaskStatus",
  pricing."riderPayoutMinor",
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP + INTERVAL '40 minutes',
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM "Order" orders
JOIN "OrderPricing" pricing ON pricing."orderId" = orders."id"
LEFT JOIN "DeliveryTask" task ON task."orderId" = orders."id"
WHERE orders."status" = 'MERCHANT_CONFIRMED' AND task."id" IS NULL;

UPDATE "Order"
SET "status" = 'READY_FOR_RIDER'
WHERE "status" = 'MERCHANT_CONFIRMED';
