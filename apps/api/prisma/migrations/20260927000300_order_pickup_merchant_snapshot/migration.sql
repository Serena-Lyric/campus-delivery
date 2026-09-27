-- Pre-production compatibility backfill: historical orders did not capture the merchant display name.
-- Current Merchant.name is the best available approximation, not an immutable reconstruction of history.
ALTER TABLE "Order" ADD COLUMN "pickupMerchantNameSnapshot" TEXT;

UPDATE "Order" orders
SET "pickupMerchantNameSnapshot" = merchant."name"
FROM "Merchant" merchant
WHERE orders."merchantId" = merchant."id";

UPDATE "Order"
SET "pickupMerchantNameSnapshot" = 'LEGACY_UNKNOWN'
WHERE "pickupMerchantNameSnapshot" IS NULL;

ALTER TABLE "Order" ALTER COLUMN "pickupMerchantNameSnapshot" SET NOT NULL;
