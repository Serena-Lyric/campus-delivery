CREATE TABLE "MerchantDailyRestoreRun" (
 "id" UUID NOT NULL PRIMARY KEY,
 "merchantId" UUID NOT NULL REFERENCES "Merchant"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
 "day" DATE NOT NULL,
 "timeZone" TEXT NOT NULL,
 "scheduledTime" TEXT NOT NULL,
 "configVersion" INTEGER NOT NULL,
 "preferenceVersion" INTEGER NOT NULL,
 "actorType" TEXT NOT NULL DEFAULT 'SYSTEM' CHECK ("actorType" = 'SYSTEM'),
 "source" TEXT NOT NULL DEFAULT 'AUTO_DAILY' CHECK ("source" = 'AUTO_DAILY'),
 "triggeredAt" TIMESTAMP(3) NOT NULL,
 "restoredCount" INTEGER NOT NULL CHECK ("restoredCount" >= 0)
);
CREATE UNIQUE INDEX "MerchantDailyRestoreRun_merchantId_day_key" ON "MerchantDailyRestoreRun"("merchantId", "day");
CREATE TABLE "ProductDailyRestoreAudit" (
 "id" UUID NOT NULL PRIMARY KEY,
 "runId" UUID NOT NULL REFERENCES "MerchantDailyRestoreRun"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
 "productId" UUID NOT NULL REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
 "version" INTEGER NOT NULL,
 "previousStatus" "ProductSaleStatus" NOT NULL CHECK ("previousStatus" = 'SOLD_OUT'),
 "newStatus" "ProductSaleStatus" NOT NULL CHECK ("newStatus" = 'ON_SALE'),
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "ProductDailyRestoreAudit_productId_version_key" ON "ProductDailyRestoreAudit"("productId", "version");
CREATE INDEX "ProductDailyRestoreAudit_runId_idx" ON "ProductDailyRestoreAudit"("runId");
