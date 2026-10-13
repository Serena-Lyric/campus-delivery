CREATE TYPE "PreparationControlState" AS ENUM ('NORMAL', 'UNABLE', 'RECOVERY_PENDING', 'MANUAL_REVIEW');
ALTER TYPE "ExceptionType" ADD VALUE 'MERCHANT_PREPARATION_UNAVAILABLE';
ALTER TABLE "Order"
  ADD COLUMN "preparationControlState" "PreparationControlState" NOT NULL DEFAULT 'NORMAL',
  ADD COLUMN "preparationControlVersion" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "preparationControlReason" TEXT,
  ADD COLUMN "preparationControlUpdatedAt" TIMESTAMP(3),
  ADD COLUMN "preparationSourceExceptionId" UUID,
  ADD COLUMN "preparationReportedAssignmentId" UUID;
ALTER TABLE "Order" ADD CONSTRAINT "Order_preparationSourceExceptionId_fkey" FOREIGN KEY ("preparationSourceExceptionId") REFERENCES "ExceptionEvent"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE TABLE "PreparationControlAudit" (
  "id" UUID NOT NULL, "orderId" UUID NOT NULL, "version" INTEGER NOT NULL,
  "action" TEXT NOT NULL, "previousState" "PreparationControlState" NOT NULL, "newState" "PreparationControlState" NOT NULL,
  "actorId" UUID, "requestKey" UUID, "payloadSignature" TEXT NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PreparationControlAudit_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "PreparationControlAudit_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "PreparationControlAudit_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "PreparationControlAudit_orderId_version_key" ON "PreparationControlAudit"("orderId", "version");
CREATE UNIQUE INDEX "PreparationControlAudit_orderId_requestKey_key" ON "PreparationControlAudit"("orderId", "requestKey");
CREATE FUNCTION preserve_preparation_control_history() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Preparation control history is append-only'; END;
$$;
CREATE TRIGGER preserve_preparation_control_history BEFORE UPDATE ON "PreparationControlAudit" FOR EACH ROW EXECUTE FUNCTION preserve_preparation_control_history();
