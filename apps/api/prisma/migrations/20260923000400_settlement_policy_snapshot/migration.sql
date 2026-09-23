-- AlterTable
ALTER TABLE "DeliveryTask" ADD COLUMN     "riderSettlementPendingSeconds" INTEGER;
UPDATE "DeliveryTask" task
SET "riderSettlementPendingSeconds" = COALESCE((config."payload"->>'riderSettlementPendingSeconds')::integer, 432000)
FROM "BusinessConfig" config
WHERE config."key" = 'ORDER_POLICY' AND config."isActive" = true;
ALTER TABLE "DeliveryTask" ADD CONSTRAINT "DeliveryTask_settlement_pending_check" CHECK (
  "riderSettlementPendingSeconds" IS NULL OR "riderSettlementPendingSeconds" >= 0
) NOT VALID;
