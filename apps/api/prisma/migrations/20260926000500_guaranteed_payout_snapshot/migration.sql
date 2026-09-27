-- AlterTable: add an explicitly named guaranteed-payout claim snapshot.
ALTER TABLE "DeliveryAssignment" ADD COLUMN "riderGuaranteedPayoutMinorAtClaim" INTEGER NOT NULL DEFAULT 0;
UPDATE "DeliveryAssignment" SET "riderGuaranteedPayoutMinorAtClaim" = "riderPayoutMinorAtClaim";
ALTER TABLE "DeliveryAssignment" ALTER COLUMN "riderGuaranteedPayoutMinorAtClaim" DROP DEFAULT;
ALTER TABLE "DeliveryAssignment" ADD CONSTRAINT "DeliveryAssignment_guaranteed_payout_snapshot_check"
  CHECK ("riderGuaranteedPayoutMinorAtClaim" >= 0);
