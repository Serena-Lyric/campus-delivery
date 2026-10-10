CREATE TABLE "RiderBlockedMerchant" (
  "riderId" UUID NOT NULL,
  "merchantId" UUID NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "RiderBlockedMerchant_pkey" PRIMARY KEY ("riderId", "merchantId"),
  CONSTRAINT "RiderBlockedMerchant_riderId_fkey" FOREIGN KEY ("riderId") REFERENCES "Rider"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "RiderBlockedMerchant_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "Merchant"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "RiderBlockedMerchant_merchantId_idx" ON "RiderBlockedMerchant"("merchantId");
