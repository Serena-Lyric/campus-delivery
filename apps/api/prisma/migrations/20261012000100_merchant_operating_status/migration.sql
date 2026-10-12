-- Preserve isOpen and all existing order/financial facts.
ALTER TABLE "Merchant" ADD COLUMN "operatingVersion" INTEGER NOT NULL DEFAULT 0;
CREATE TABLE "MerchantOperatingStatusAudit" (
  "id" UUID NOT NULL,
  "merchantId" UUID NOT NULL,
  "version" INTEGER NOT NULL,
  "previousIsOpen" BOOLEAN NOT NULL,
  "newIsOpen" BOOLEAN NOT NULL,
  "actorId" UUID NOT NULL,
  "reason" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "MerchantOperatingStatusAudit_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "MerchantOperatingStatusAudit_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "Merchant"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "MerchantOperatingStatusAudit_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "MerchantOperatingStatusAudit_merchantId_version_key" ON "MerchantOperatingStatusAudit"("merchantId", "version");
CREATE INDEX "MerchantOperatingStatusAudit_merchantId_createdAt_idx" ON "MerchantOperatingStatusAudit"("merchantId", "createdAt");
