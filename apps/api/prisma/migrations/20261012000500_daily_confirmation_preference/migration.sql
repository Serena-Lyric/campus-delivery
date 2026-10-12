ALTER TABLE "Merchant" ADD COLUMN "dailyConfirmationEnabled" BOOLEAN NOT NULL DEFAULT false,
 ADD COLUMN "dailyConfirmationVersion" INTEGER NOT NULL DEFAULT 0,
 ADD COLUMN "dailyConfirmationEffectiveAt" TIMESTAMP(3);
CREATE TABLE "MerchantDailyConfirmationPreferenceAudit" (
 "id" UUID NOT NULL PRIMARY KEY,
 "merchantId" UUID NOT NULL REFERENCES "Merchant"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
 "version" INTEGER NOT NULL,
 "previousEnabled" BOOLEAN NOT NULL,
 "newEnabled" BOOLEAN NOT NULL,
 "effectiveAt" TIMESTAMP(3),
 "actorId" UUID NOT NULL REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
 "reason" TEXT NOT NULL,
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "MerchantDailyConfirmationPreferenceAudit_merchantId_version_key" ON "MerchantDailyConfirmationPreferenceAudit"("merchantId", "version");
CREATE INDEX "MerchantDailyConfirmationPreferenceAudit_merchantId_createdAt_idx" ON "MerchantDailyConfirmationPreferenceAudit"("merchantId", "createdAt");
