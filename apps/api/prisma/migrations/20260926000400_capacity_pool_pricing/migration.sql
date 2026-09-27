-- CreateEnum
CREATE TYPE "RiderCapacityStage" AS ENUM ('TUTORIAL', 'FIRST_DELIVERY_SAME_DAY', 'STANDARD');
CREATE TYPE "RiderCapacityEventType" AS ENUM ('FIRST_DELIVERY_UPGRADE', 'NEXT_DAY_UPGRADE', 'ADMIN_OVERRIDE_SET', 'ADMIN_OVERRIDE_CLEARED');
CREATE TYPE "FoodType" AS ENUM ('DRINK', 'RICE_MEAL', 'NOODLE', 'SOUP', 'CAKE_DESSERT', 'OTHER', 'UNKNOWN');

-- AlterTable: location and merchant reference-price facts.
ALTER TABLE "CampusLocation" ADD COLUMN "regionLabel" TEXT;
ALTER TABLE "Merchant" ADD COLUMN "baseDeliveryPriceMinor" INTEGER NOT NULL DEFAULT 0;
UPDATE "Merchant" SET "baseDeliveryPriceMinor" = "deliveryContributionMinor", "deliveryContributionMinor" = 0;
ALTER TABLE "Merchant" ADD CONSTRAINT "Merchant_base_delivery_price_check" CHECK ("baseDeliveryPriceMinor" >= 0);

-- AlterTable: rider capacity facts.
ALTER TABLE "Rider"
  ADD COLUMN "firstNormalDeliveredAt" TIMESTAMP(3),
  ADD COLUMN "capacityOverride" INTEGER;
ALTER TABLE "Rider" ADD CONSTRAINT "Rider_capacity_override_check" CHECK ("capacityOverride" IS NULL OR "capacityOverride" > 0);

-- AlterTable: immutable order location snapshots.
ALTER TABLE "Order"
  ADD COLUMN "destinationRegionSnapshot" TEXT,
  ADD COLUMN "pickupLocationNameSnapshot" TEXT,
  ADD COLUMN "pickupRegionSnapshot" TEXT;
UPDATE "Order" orders
SET "pickupLocationNameSnapshot" = location."name",
    "pickupRegionSnapshot" = location."regionLabel"
FROM "Merchant" merchant
JOIN "CampusLocation" location ON location."id" = merchant."campusLocationId"
WHERE orders."merchantId" = merchant."id";
UPDATE "Order" orders
SET "destinationRegionSnapshot" = location."regionLabel"
FROM "CampusLocation" location
WHERE orders."destinationLocationId" = location."id";
UPDATE "Order" SET "pickupLocationNameSnapshot" = 'LEGACY_UNKNOWN' WHERE "pickupLocationNameSnapshot" IS NULL;
ALTER TABLE "Order" ALTER COLUMN "pickupLocationNameSnapshot" SET NOT NULL;

-- AlterTable: original category and low-risk classifier snapshot.
ALTER TABLE "OrderItem"
  ADD COLUMN "merchantCategoryNameSnapshot" TEXT NOT NULL DEFAULT 'LEGACY_UNKNOWN',
  ADD COLUMN "suggestedFoodType" "FoodType" NOT NULL DEFAULT 'UNKNOWN',
  ADD COLUMN "handlingTags" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "classificationSource" TEXT NOT NULL DEFAULT 'LEGACY_MIGRATION',
  ADD COLUMN "classificationVersion" TEXT NOT NULL DEFAULT '1',
  ADD COLUMN "classificationConfidenceBps" INTEGER NOT NULL DEFAULT 0;
UPDATE "OrderItem" item
SET "merchantCategoryNameSnapshot" = category."name"
FROM "Product" product
JOIN "ProductCategory" category ON category."id" = product."categoryId"
WHERE item."productId" = product."id";
ALTER TABLE "OrderItem" ADD CONSTRAINT "OrderItem_classification_confidence_check"
  CHECK ("classificationConfidenceBps" BETWEEN 0 AND 10000);

-- AlterTable: split reference price, real rescue funding, rider base, guarantee and platform contribution.
ALTER TABLE "OrderPricing"
  ADD COLUMN "merchantBaseDeliveryPriceMinor" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "riderBasePayoutMinor" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "merchantRescueContributionMinor" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "riderGuaranteedPayoutMinor" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "deliveryPlatformContributionMinor" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "pricingPolicyVersion" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "pricingInputsSnapshot" JSONB,
  ADD COLUMN "pricingReason" TEXT,
  ADD COLUMN "merchantRescueContributionVersion" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "merchantRescueUpdatedAt" TIMESTAMP(3);

UPDATE "OrderPricing"
SET "merchantBaseDeliveryPriceMinor" = "merchantDeliveryContributionMinor",
    "riderBasePayoutMinor" = GREATEST(0, "riderPayoutMinor" - "customerRiderTipMinor" - "platformSubsidyMinor"),
    "merchantRescueContributionMinor" = 0,
    "riderGuaranteedPayoutMinor" = "riderPayoutMinor",
    "deliveryPlatformContributionMinor" = "customerDeliveryFeeMinor" - GREATEST(0, "riderPayoutMinor" - "customerRiderTipMinor" - "platformSubsidyMinor") - "platformSubsidyMinor",
    "pricingPolicyVersion" = 1,
    "pricingInputsSnapshot" = jsonb_build_object('source', 'LEGACY_MIGRATION'),
    "pricingReason" = 'LEGACY_MIGRATION',
    "merchantSettlementMinor" = "merchantSettlementMinor" + "merchantDeliveryContributionMinor",
    "merchantDeliveryContributionMinor" = 0;

UPDATE "Settlement" settlement
SET "merchantPayableMinor" = settlement."merchantPayableMinor" + pricing."merchantBaseDeliveryPriceMinor"
FROM "OrderPricing" pricing
WHERE settlement."orderId" = pricing."orderId" AND settlement."status" = 'FINALIZED';

ALTER TABLE "OrderPricing" ADD CONSTRAINT "OrderPricing_split_delivery_amounts_check" CHECK (
  "merchantBaseDeliveryPriceMinor" >= 0 AND
  "riderBasePayoutMinor" >= 0 AND
  "merchantRescueContributionMinor" >= 0 AND
  "riderGuaranteedPayoutMinor" >= 0 AND
  "pricingPolicyVersion" >= 0 AND
  "merchantRescueContributionVersion" >= 0
);

-- AlterTable: atomic claim snapshot for every funding source.
ALTER TABLE "DeliveryAssignment"
  ADD COLUMN "customerDeliveryFeeMinorAtClaim" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "riderBasePayoutMinorAtClaim" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "merchantRescueContributionMinorAtClaim" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "deliveryPlatformContributionMinorAtClaim" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "pricingPolicyVersionAtClaim" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "pricingInputsSnapshotAtClaim" JSONB NOT NULL DEFAULT '{}'::JSONB;
UPDATE "DeliveryAssignment" assignment
SET "customerDeliveryFeeMinorAtClaim" = pricing."customerDeliveryFeeMinor",
    "riderBasePayoutMinorAtClaim" = pricing."riderBasePayoutMinor",
    "merchantRescueContributionMinorAtClaim" = pricing."merchantRescueContributionMinor",
    "deliveryPlatformContributionMinorAtClaim" = pricing."deliveryPlatformContributionMinor",
    "pricingPolicyVersionAtClaim" = GREATEST(1, pricing."pricingPolicyVersion"),
    "pricingInputsSnapshotAtClaim" = COALESCE(pricing."pricingInputsSnapshot", '{}'::JSONB)
FROM "OrderPricing" pricing
WHERE assignment."orderId" = pricing."orderId";
ALTER TABLE "DeliveryAssignment"
  ALTER COLUMN "customerDeliveryFeeMinorAtClaim" DROP DEFAULT,
  ALTER COLUMN "riderBasePayoutMinorAtClaim" DROP DEFAULT,
  ALTER COLUMN "merchantRescueContributionMinorAtClaim" DROP DEFAULT,
  ALTER COLUMN "deliveryPlatformContributionMinorAtClaim" DROP DEFAULT,
  ALTER COLUMN "pricingPolicyVersionAtClaim" DROP DEFAULT,
  ALTER COLUMN "pricingInputsSnapshotAtClaim" DROP DEFAULT;
ALTER TABLE "DeliveryAssignment" ADD CONSTRAINT "DeliveryAssignment_split_pricing_snapshot_check" CHECK (
  "customerDeliveryFeeMinorAtClaim" >= 0 AND
  "riderBasePayoutMinorAtClaim" >= 0 AND
  "merchantRescueContributionMinorAtClaim" >= 0 AND
  "pricingPolicyVersionAtClaim" > 0
);

-- CreateTable: capacity changes and merchant rescue funding history.
CREATE TABLE "RiderCapacityEvent" (
  "id" UUID NOT NULL,
  "riderId" UUID NOT NULL,
  "type" "RiderCapacityEventType" NOT NULL,
  "stage" "RiderCapacityStage" NOT NULL,
  "previousCapacity" INTEGER NOT NULL,
  "newCapacity" INTEGER NOT NULL,
  "actorId" UUID,
  "reason" TEXT NOT NULL,
  "stageEventKey" TEXT,
  "metadata" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "RiderCapacityEvent_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "RiderCapacityEvent_stageEventKey_key" ON "RiderCapacityEvent"("stageEventKey");
CREATE INDEX "RiderCapacityEvent_riderId_createdAt_idx" ON "RiderCapacityEvent"("riderId", "createdAt");
ALTER TABLE "RiderCapacityEvent" ADD CONSTRAINT "RiderCapacityEvent_riderId_fkey" FOREIGN KEY ("riderId") REFERENCES "Rider"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RiderCapacityEvent" ADD CONSTRAINT "RiderCapacityEvent_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "RiderCapacityEvent" ADD CONSTRAINT "RiderCapacityEvent_values_check" CHECK ("previousCapacity" > 0 AND "newCapacity" > 0);

CREATE TABLE "MerchantRescueContributionEvent" (
  "id" UUID NOT NULL,
  "orderId" UUID NOT NULL,
  "version" INTEGER NOT NULL,
  "previousMinor" INTEGER NOT NULL,
  "addedMinor" INTEGER NOT NULL,
  "newMinor" INTEGER NOT NULL,
  "operatorId" UUID NOT NULL,
  "reason" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "MerchantRescueContributionEvent_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "MerchantRescueContributionEvent_orderId_version_key" ON "MerchantRescueContributionEvent"("orderId", "version");
CREATE INDEX "MerchantRescueContributionEvent_orderId_createdAt_idx" ON "MerchantRescueContributionEvent"("orderId", "createdAt");
ALTER TABLE "MerchantRescueContributionEvent" ADD CONSTRAINT "MerchantRescueContributionEvent_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MerchantRescueContributionEvent" ADD CONSTRAINT "MerchantRescueContributionEvent_operatorId_fkey" FOREIGN KEY ("operatorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "MerchantRescueContributionEvent" ADD CONSTRAINT "MerchantRescueContributionEvent_values_check" CHECK (
  "version" > 0 AND "previousMinor" >= 0 AND "addedMinor" > 0 AND "newMinor" = "previousMinor" + "addedMinor"
);

-- Replace the old single delivery fee config with provisional split pricing inputs and raise the first-version global cap.
UPDATE "BusinessConfig"
SET "payload" = ("payload" - 'customerDeliveryFeeMinor') || jsonb_build_object(
  'platformMaxConcurrentOrdersPerRider', 10,
  'deliveryPricingDefaultCustomerFeeMinor', 300,
  'deliveryPricingDefaultRiderBasePayoutMinor', 200,
  'deliveryPricingAdditionalItemCustomerFeeMinor', 20,
  'deliveryPricingAdditionalItemRiderPayoutMinor', 20,
  'deliveryPricingMerchantOverrides', '[]'::jsonb
)
WHERE "key" = 'ORDER_POLICY';
