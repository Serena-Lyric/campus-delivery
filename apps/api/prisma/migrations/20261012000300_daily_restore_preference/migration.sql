ALTER TABLE "Merchant" ADD COLUMN "dailyProductRestoreEnabled" BOOLEAN NOT NULL DEFAULT false,
 ADD COLUMN "dailyProductRestoreVersion" INTEGER NOT NULL DEFAULT 0;
CREATE TABLE "MerchantDailyRestorePreferenceAudit" (
 "id" UUID NOT NULL PRIMARY KEY,
 "merchantId" UUID NOT NULL REFERENCES "Merchant"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
 "version" INTEGER NOT NULL,
 "previousEnabled" BOOLEAN NOT NULL,
 "newEnabled" BOOLEAN NOT NULL,
 "actorId" UUID NOT NULL REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
 "reason" TEXT NOT NULL,
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "MerchantDailyRestorePreferenceAudit_merchantId_version_key" ON "MerchantDailyRestorePreferenceAudit"("merchantId", "version");
CREATE INDEX "MerchantDailyRestorePreferenceAudit_merchantId_createdAt_idx" ON "MerchantDailyRestorePreferenceAudit"("merchantId", "createdAt");
