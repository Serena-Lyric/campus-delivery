-- CreateEnum
CREATE TYPE "PickupCustodyStatus" AS ENUM ('OPEN', 'NOT_HANDED_OVER', 'HANDED_OVER', 'INCONCLUSIVE');

-- AlterEnum
ALTER TYPE "ExceptionType" ADD VALUE 'PICKUP_CUSTODY_DISPUTE';

-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "pickupHandoffRevision" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "VerificationCode" ADD COLUMN     "assignmentId" UUID,
ADD COLUMN     "failedAttempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "handoffRevision" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "protocolVersion" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "PickupHandoff" (
    "id" UUID NOT NULL,
    "orderId" UUID NOT NULL,
    "assignmentId" UUID NOT NULL,
    "revision" INTEGER NOT NULL,
    "requestKey" UUID NOT NULL,
    "merchantActorId" UUID NOT NULL,
    "eventId" UUID NOT NULL,
    "photoEvidenceId" UUID,
    "verificationCodeId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PickupHandoff_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PickupCustodyDispute" (
    "id" UUID NOT NULL,
    "orderId" UUID NOT NULL,
    "handoffId" UUID NOT NULL,
    "caseId" UUID NOT NULL,
    "reason" TEXT NOT NULL,
    "evidenceIds" UUID[] DEFAULT ARRAY[]::UUID[],
    "catalogRiskClaim" JSONB,
    "status" "PickupCustodyStatus" NOT NULL DEFAULT 'OPEN',
    "version" INTEGER NOT NULL DEFAULT 0,
    "merchantAcknowledgedAt" TIMESTAMP(3),
    "merchantNote" TEXT,
    "resolutionNote" TEXT,
    "resolutionKey" UUID,
    "resolvedFromVersion" INTEGER,
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PickupCustodyDispute_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PickupHandoff_eventId_key" ON "PickupHandoff"("eventId");

-- CreateIndex
CREATE INDEX "PickupHandoff_assignmentId_idx" ON "PickupHandoff"("assignmentId");

-- CreateIndex
CREATE UNIQUE INDEX "PickupHandoff_orderId_requestKey_key" ON "PickupHandoff"("orderId", "requestKey");

-- CreateIndex
CREATE UNIQUE INDEX "PickupHandoff_orderId_revision_key" ON "PickupHandoff"("orderId", "revision");

-- CreateIndex
CREATE UNIQUE INDEX "PickupCustodyDispute_handoffId_key" ON "PickupCustodyDispute"("handoffId");

-- CreateIndex
CREATE UNIQUE INDEX "PickupCustodyDispute_caseId_key" ON "PickupCustodyDispute"("caseId");

-- CreateIndex
CREATE INDEX "PickupCustodyDispute_orderId_status_idx" ON "PickupCustodyDispute"("orderId", "status");

-- AddForeignKey
ALTER TABLE "VerificationCode" ADD CONSTRAINT "VerificationCode_assignmentId_fkey" FOREIGN KEY ("assignmentId") REFERENCES "DeliveryAssignment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PickupHandoff" ADD CONSTRAINT "PickupHandoff_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PickupHandoff" ADD CONSTRAINT "PickupHandoff_assignmentId_fkey" FOREIGN KEY ("assignmentId") REFERENCES "DeliveryAssignment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PickupCustodyDispute" ADD CONSTRAINT "PickupCustodyDispute_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PickupCustodyDispute" ADD CONSTRAINT "PickupCustodyDispute_handoffId_fkey" FOREIGN KEY ("handoffId") REFERENCES "PickupHandoff"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PickupCustodyDispute" ADD CONSTRAINT "PickupCustodyDispute_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "ExceptionCase"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Old merchant-issued pickup codes are incompatible with the new participation boundary.
UPDATE "VerificationCode" SET "invalidatedAt" = CURRENT_TIMESTAMP
WHERE "purpose" = 'PICKUP' AND "protocolVersion" = 0 AND "verifiedAt" IS NULL AND "invalidatedAt" IS NULL;
ALTER TABLE "VerificationCode" ADD CONSTRAINT "VerificationCode_failedAttempts_check" CHECK ("failedAttempts" >= 0);
ALTER TABLE "Order" ADD CONSTRAINT "Order_pickupHandoffRevision_check" CHECK ("pickupHandoffRevision" >= 0);
