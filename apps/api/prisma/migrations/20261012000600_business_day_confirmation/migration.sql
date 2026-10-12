CREATE TYPE "MerchantBusinessConfirmationSource" AS ENUM ('EXPLICIT_CONFIRM', 'MANUAL_OPEN');
CREATE TABLE "MerchantBusinessDayConfirmation" (
 "id" UUID NOT NULL PRIMARY KEY,
 "merchantId" UUID NOT NULL REFERENCES "Merchant"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
 "businessDayStartsAt" TIMESTAMP(3) NOT NULL,
 "businessDay" DATE NOT NULL,
 "timeZone" TEXT NOT NULL,
 "switchingTime" TEXT NOT NULL,
 "policyVersion" INTEGER NOT NULL,
 "source" "MerchantBusinessConfirmationSource" NOT NULL,
 "actorId" UUID NOT NULL REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
 "operatingVersion" INTEGER NOT NULL,
 "reason" TEXT NOT NULL,
 "confirmedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "MerchantBusinessDayConfirmation_merchant_start_key" ON "MerchantBusinessDayConfirmation"("merchantId", "businessDayStartsAt");
CREATE INDEX "MerchantBusinessDayConfirmation_merchant_confirmed_idx" ON "MerchantBusinessDayConfirmation"("merchantId", "confirmedAt");
