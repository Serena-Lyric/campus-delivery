CREATE TYPE "PickupEvidenceLevel" AS ENUM ('NONE','RECOMMENDED','REQUIRED');
ALTER TYPE "ExceptionType" ADD VALUE 'PICKUP_EVIDENCE_UNAVAILABLE';
ALTER TABLE "Order"
 ADD COLUMN "coreFragileValueMinor" INTEGER NOT NULL DEFAULT 0,
 ADD COLUMN "pickupEvidenceLevel" "PickupEvidenceLevel" NOT NULL DEFAULT 'NONE',
 ADD COLUMN "pickupEvidencePolicyVersion" INTEGER NOT NULL DEFAULT 0,
 ADD COLUMN "pickupEvidenceRecommendedMinor" INTEGER,
 ADD COLUMN "pickupEvidenceRequiredMinor" INTEGER;
-- Existing orders retain their original obligations; version 0 denotes unassessed legacy policy.
