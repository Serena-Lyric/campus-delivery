-- Additive only: legacy quotation version 0 denotes an unversioned starting value.
-- No price, settlement, historical config or audit fact is reinterpreted/backfilled.
ALTER TABLE "Merchant" ADD COLUMN "baseDeliveryQuoteVersion" INTEGER NOT NULL DEFAULT 0;

CREATE TABLE "MerchantBaseDeliveryQuoteAudit" (
    "id" UUID NOT NULL,
    "merchantId" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "previousMinor" INTEGER NOT NULL,
    "newMinor" INTEGER NOT NULL,
    "actorId" UUID NOT NULL,
    "reason" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "MerchantBaseDeliveryQuoteAudit_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "MerchantBaseDeliveryQuoteAudit_merchantId_version_key" ON "MerchantBaseDeliveryQuoteAudit"("merchantId", "version");
CREATE INDEX "MerchantBaseDeliveryQuoteAudit_merchantId_createdAt_idx" ON "MerchantBaseDeliveryQuoteAudit"("merchantId", "createdAt");
ALTER TABLE "MerchantBaseDeliveryQuoteAudit" ADD CONSTRAINT "MerchantBaseDeliveryQuoteAudit_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "Merchant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "MerchantBaseDeliveryQuoteAudit" ADD CONSTRAINT "MerchantBaseDeliveryQuoteAudit_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
