-- CreateEnum
CREATE TYPE "AdminLevel" AS ENUM ('OPERATOR', 'SUPER_ADMIN');
CREATE TYPE "RiderCancellationReason" AS ENUM ('PERSONAL_EMERGENCY', 'VEHICLE_ISSUE', 'OTHER');
CREATE TYPE "RiderRestrictionType" AS ENUM ('SAME_DAY_NEW_CLAIM_PAUSE', 'ROLLING_CANCELLATION_COOLDOWN', 'ROLLING_WARNING_COOLDOWN', 'MANUAL');
CREATE TYPE "RiderRestrictionStatus" AS ENUM ('ACTIVE', 'RELEASED', 'OVERRIDDEN');
CREATE TYPE "RiderRestrictionSource" AS ENUM ('AUTOMATIC', 'ADMIN');
CREATE TYPE "ExceptionCasePriority" AS ENUM ('UNKNOWN', 'LOW', 'MEDIUM', 'HIGH');
CREATE TYPE "ExceptionCaseStatus" AS ENUM ('OPEN', 'IN_PROGRESS', 'WAITING_FOR_PARTICIPANT', 'ESCALATED', 'RESOLVED', 'CLOSED');
CREATE TYPE "ExceptionResolutionType" AS ENUM ('REMAKE_AND_CONTINUE', 'REFUND_AND_CLOSE', 'WAITING_FOR_INFORMATION', 'RESPONSIBILITY_UNDETERMINED', 'CONTINUE_FULFILLMENT', 'ESCALATED_OTHER');
CREATE TYPE "ExceptionCaseActionType" AS ENUM ('CREATED', 'CLAIMED', 'RELEASED', 'TRANSFERRED', 'TAKEN_OVER', 'ESCALATED', 'REQUESTED_INFORMATION', 'RESOLVED', 'CLASSIFIED', 'REFUND_EXECUTED', 'RESERVATION_RELEASED');
CREATE TYPE "RemakeProposalStatus" AS ENUM ('PENDING', 'ACCEPTED', 'REJECTED');
CREATE TYPE "CompensationStatus" AS ENUM ('OPEN', 'FUNDED', 'PARTIALLY_FUNDED', 'RESOLVED');
CREATE TYPE "CompensationFundingSource" AS ENUM ('CURRENT_ORDER_SETTLEMENT', 'OTHER_UNWITHDRAWN_SETTLEMENT', 'RIDER_VOLUNTARY_PAYMENT', 'PLATFORM_ADVANCE');

-- Extend existing enums. These values are consumed only after this migration commits.
ALTER TYPE "ExceptionType" ADD VALUE 'MINOR_DAMAGE_OR_DELAY';
ALTER TYPE "ExceptionType" ADD VALUE 'SEVERE_FOOD_DAMAGE';
ALTER TYPE "ExceptionType" ADD VALUE 'FOOD_LOST';
ALTER TYPE "ExceptionType" ADD VALUE 'OTHER_NEEDS_REVIEW';
ALTER TYPE "OrderEventType" ADD VALUE 'RIDER_PRE_PICKUP_CANCELLED';

-- AlterTable
ALTER TABLE "RiderSettlement" ADD COLUMN "reservedMinor" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "RiderSettlement" ADD CONSTRAINT "RiderSettlement_reserved_check"
  CHECK ("reservedMinor" >= 0 AND "reservedMinor" <= "amountMinor");

-- CreateTable
CREATE TABLE "AdminProfile" (
  "id" UUID NOT NULL,
  "userId" UUID NOT NULL,
  "level" "AdminLevel" NOT NULL DEFAULT 'OPERATOR',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "AdminProfile_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AdminProfileAudit" (
  "id" UUID NOT NULL,
  "targetUserId" UUID NOT NULL,
  "actorId" UUID NOT NULL,
  "previousLevel" "AdminLevel",
  "newLevel" "AdminLevel" NOT NULL,
  "reason" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AdminProfileAudit_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "RiderCancellationEvent" (
  "id" UUID NOT NULL,
  "riderId" UUID NOT NULL,
  "taskId" UUID NOT NULL,
  "orderId" UUID NOT NULL,
  "assignmentId" UUID NOT NULL,
  "reason" "RiderCancellationReason" NOT NULL,
  "note" TEXT,
  "campusDay" DATE NOT NULL,
  "dailyCount" INTEGER NOT NULL,
  "rollingCount" INTEGER NOT NULL,
  "warningIssued" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "RiderCancellationEvent_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "RiderRestriction" (
  "id" UUID NOT NULL,
  "riderId" UUID NOT NULL,
  "type" "RiderRestrictionType" NOT NULL,
  "status" "RiderRestrictionStatus" NOT NULL DEFAULT 'ACTIVE',
  "source" "RiderRestrictionSource" NOT NULL,
  "reason" TEXT NOT NULL,
  "startsAt" TIMESTAMP(3) NOT NULL,
  "endsAt" TIMESTAMP(3) NOT NULL,
  "releasedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "RiderRestriction_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "RiderRestrictionAudit" (
  "id" UUID NOT NULL,
  "restrictionId" UUID NOT NULL,
  "actorId" UUID,
  "previousStatus" "RiderRestrictionStatus",
  "newStatus" "RiderRestrictionStatus" NOT NULL,
  "previousEndsAt" TIMESTAMP(3),
  "newEndsAt" TIMESTAMP(3) NOT NULL,
  "reason" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "RiderRestrictionAudit_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ExceptionCase" (
  "id" UUID NOT NULL,
  "orderId" UUID NOT NULL,
  "exceptionEventId" UUID NOT NULL,
  "category" "ExceptionType" NOT NULL,
  "subtype" TEXT,
  "priority" "ExceptionCasePriority" NOT NULL DEFAULT 'UNKNOWN',
  "status" "ExceptionCaseStatus" NOT NULL DEFAULT 'OPEN',
  "currentHandlerAdminId" UUID,
  "claimedAt" TIMESTAMP(3),
  "lastActionAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "resolutionType" "ExceptionResolutionType",
  "resolutionNote" TEXT,
  "escalatedAt" TIMESTAMP(3),
  "escalationReason" TEXT,
  "version" INTEGER NOT NULL DEFAULT 0,
  "classifierSource" TEXT,
  "classifierVersion" TEXT,
  "classifierResult" JSONB,
  "classifierConfidenceBps" INTEGER,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "resolvedAt" TIMESTAMP(3),
  CONSTRAINT "ExceptionCase_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ExceptionCaseAction" (
  "id" UUID NOT NULL,
  "caseId" UUID NOT NULL,
  "type" "ExceptionCaseActionType" NOT NULL,
  "actorId" UUID,
  "previousHandlerAdminId" UUID,
  "nextHandlerAdminId" UUID,
  "reason" TEXT NOT NULL,
  "metadata" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ExceptionCaseAction_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "RemakeProposal" (
  "id" UUID NOT NULL,
  "caseId" UUID NOT NULL,
  "orderId" UUID NOT NULL,
  "riderId" UUID NOT NULL,
  "message" TEXT NOT NULL,
  "status" "RemakeProposalStatus" NOT NULL DEFAULT 'PENDING',
  "respondedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "RemakeProposal_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "CompensationObligation" (
  "id" UUID NOT NULL,
  "caseId" UUID NOT NULL,
  "orderId" UUID NOT NULL,
  "riderId" UUID NOT NULL,
  "requiredCompensationMinor" INTEGER NOT NULL,
  "currentOrderReservedMinor" INTEGER NOT NULL DEFAULT 0,
  "otherUnwithdrawnReservedMinor" INTEGER NOT NULL DEFAULT 0,
  "riderVoluntaryPaymentMinor" INTEGER NOT NULL DEFAULT 0,
  "platformAdvancedMinor" INTEGER NOT NULL DEFAULT 0,
  "customerRefundMinor" INTEGER NOT NULL DEFAULT 0,
  "outstandingMinor" INTEGER NOT NULL DEFAULT 0,
  "status" "CompensationStatus" NOT NULL DEFAULT 'OPEN',
  "idempotencyKey" TEXT NOT NULL,
  "releaseIdempotencyKey" TEXT,
  "actorId" UUID NOT NULL,
  "reason" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "resolvedAt" TIMESTAMP(3),
  "releasedAt" TIMESTAMP(3),
  CONSTRAINT "CompensationObligation_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "CompensationAllocation" (
  "id" UUID NOT NULL,
  "obligationId" UUID NOT NULL,
  "source" "CompensationFundingSource" NOT NULL,
  "riderSettlementId" UUID,
  "amountMinor" INTEGER NOT NULL,
  "releasedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CompensationAllocation_pkey" PRIMARY KEY ("id")
);

-- Indexes and unique invariants.
CREATE UNIQUE INDEX "AdminProfile_userId_key" ON "AdminProfile"("userId");
CREATE INDEX "AdminProfileAudit_targetUserId_createdAt_idx" ON "AdminProfileAudit"("targetUserId", "createdAt");
CREATE UNIQUE INDEX "RiderCancellationEvent_assignmentId_key" ON "RiderCancellationEvent"("assignmentId");
CREATE INDEX "RiderCancellationEvent_riderId_campusDay_idx" ON "RiderCancellationEvent"("riderId", "campusDay");
CREATE INDEX "RiderCancellationEvent_riderId_createdAt_idx" ON "RiderCancellationEvent"("riderId", "createdAt");
CREATE INDEX "RiderRestriction_riderId_status_endsAt_idx" ON "RiderRestriction"("riderId", "status", "endsAt");
CREATE UNIQUE INDEX "RiderRestriction_one_active_type" ON "RiderRestriction"("riderId", "type") WHERE "status" = 'ACTIVE';
CREATE INDEX "RiderRestrictionAudit_restrictionId_createdAt_idx" ON "RiderRestrictionAudit"("restrictionId", "createdAt");
CREATE UNIQUE INDEX "ExceptionCase_exceptionEventId_key" ON "ExceptionCase"("exceptionEventId");
CREATE INDEX "ExceptionCase_status_priority_createdAt_idx" ON "ExceptionCase"("status", "priority", "createdAt");
CREATE INDEX "ExceptionCase_currentHandlerAdminId_status_idx" ON "ExceptionCase"("currentHandlerAdminId", "status");
CREATE INDEX "ExceptionCase_orderId_createdAt_idx" ON "ExceptionCase"("orderId", "createdAt");
CREATE INDEX "ExceptionCaseAction_caseId_createdAt_idx" ON "ExceptionCaseAction"("caseId", "createdAt");
CREATE UNIQUE INDEX "RemakeProposal_caseId_key" ON "RemakeProposal"("caseId");
CREATE UNIQUE INDEX "CompensationObligation_caseId_key" ON "CompensationObligation"("caseId");
CREATE UNIQUE INDEX "CompensationObligation_idempotencyKey_key" ON "CompensationObligation"("idempotencyKey");
CREATE UNIQUE INDEX "CompensationObligation_releaseIdempotencyKey_key" ON "CompensationObligation"("releaseIdempotencyKey");
CREATE INDEX "CompensationAllocation_obligationId_createdAt_idx" ON "CompensationAllocation"("obligationId", "createdAt");
CREATE INDEX "CompensationAllocation_riderSettlementId_idx" ON "CompensationAllocation"("riderSettlementId");
CREATE UNIQUE INDEX "CompensationAllocation_obligation_settlement_source_key" ON "CompensationAllocation"("obligationId", "riderSettlementId", "source");
CREATE UNIQUE INDEX "CompensationAllocation_one_nonsettlement_source" ON "CompensationAllocation"("obligationId", "source") WHERE "riderSettlementId" IS NULL;

-- Foreign keys.
ALTER TABLE "AdminProfile" ADD CONSTRAINT "AdminProfile_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AdminProfileAudit" ADD CONSTRAINT "AdminProfileAudit_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "RiderCancellationEvent" ADD CONSTRAINT "RiderCancellationEvent_riderId_fkey" FOREIGN KEY ("riderId") REFERENCES "Rider"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RiderCancellationEvent" ADD CONSTRAINT "RiderCancellationEvent_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "DeliveryTask"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RiderCancellationEvent" ADD CONSTRAINT "RiderCancellationEvent_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RiderCancellationEvent" ADD CONSTRAINT "RiderCancellationEvent_assignmentId_fkey" FOREIGN KEY ("assignmentId") REFERENCES "DeliveryAssignment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "RiderRestriction" ADD CONSTRAINT "RiderRestriction_riderId_fkey" FOREIGN KEY ("riderId") REFERENCES "Rider"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RiderRestrictionAudit" ADD CONSTRAINT "RiderRestrictionAudit_restrictionId_fkey" FOREIGN KEY ("restrictionId") REFERENCES "RiderRestriction"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RiderRestrictionAudit" ADD CONSTRAINT "RiderRestrictionAudit_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ExceptionCase" ADD CONSTRAINT "ExceptionCase_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ExceptionCase" ADD CONSTRAINT "ExceptionCase_exceptionEventId_fkey" FOREIGN KEY ("exceptionEventId") REFERENCES "ExceptionEvent"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ExceptionCase" ADD CONSTRAINT "ExceptionCase_currentHandlerAdminId_fkey" FOREIGN KEY ("currentHandlerAdminId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ExceptionCaseAction" ADD CONSTRAINT "ExceptionCaseAction_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "ExceptionCase"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ExceptionCaseAction" ADD CONSTRAINT "ExceptionCaseAction_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ExceptionCaseAction" ADD CONSTRAINT "ExceptionCaseAction_previousHandlerAdminId_fkey" FOREIGN KEY ("previousHandlerAdminId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ExceptionCaseAction" ADD CONSTRAINT "ExceptionCaseAction_nextHandlerAdminId_fkey" FOREIGN KEY ("nextHandlerAdminId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "RemakeProposal" ADD CONSTRAINT "RemakeProposal_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "ExceptionCase"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RemakeProposal" ADD CONSTRAINT "RemakeProposal_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RemakeProposal" ADD CONSTRAINT "RemakeProposal_riderId_fkey" FOREIGN KEY ("riderId") REFERENCES "Rider"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CompensationObligation" ADD CONSTRAINT "CompensationObligation_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "ExceptionCase"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CompensationObligation" ADD CONSTRAINT "CompensationObligation_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CompensationObligation" ADD CONSTRAINT "CompensationObligation_riderId_fkey" FOREIGN KEY ("riderId") REFERENCES "Rider"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CompensationObligation" ADD CONSTRAINT "CompensationObligation_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CompensationAllocation" ADD CONSTRAINT "CompensationAllocation_obligationId_fkey" FOREIGN KEY ("obligationId") REFERENCES "CompensationObligation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CompensationAllocation" ADD CONSTRAINT "CompensationAllocation_riderSettlementId_fkey" FOREIGN KEY ("riderSettlementId") REFERENCES "RiderSettlement"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Value constraints.
ALTER TABLE "RiderCancellationEvent" ADD CONSTRAINT "RiderCancellationEvent_counts_check" CHECK ("dailyCount" > 0 AND "rollingCount" > 0);
ALTER TABLE "RiderRestriction" ADD CONSTRAINT "RiderRestriction_window_check" CHECK ("endsAt" > "startsAt");
ALTER TABLE "ExceptionCase" ADD CONSTRAINT "ExceptionCase_values_check" CHECK ("version" >= 0 AND ("classifierConfidenceBps" IS NULL OR "classifierConfidenceBps" BETWEEN 0 AND 10000));
ALTER TABLE "CompensationObligation" ADD CONSTRAINT "CompensationObligation_amounts_check" CHECK (
  "requiredCompensationMinor" >= 0 AND
  "currentOrderReservedMinor" >= 0 AND
  "otherUnwithdrawnReservedMinor" >= 0 AND
  "riderVoluntaryPaymentMinor" >= 0 AND
  "platformAdvancedMinor" >= 0 AND
  "customerRefundMinor" >= 0 AND
  "outstandingMinor" >= 0 AND
  "currentOrderReservedMinor" + "otherUnwithdrawnReservedMinor" + "riderVoluntaryPaymentMinor" + "platformAdvancedMinor" = "customerRefundMinor"
);
ALTER TABLE "CompensationAllocation" ADD CONSTRAINT "CompensationAllocation_amount_check" CHECK ("amountMinor" > 0);

-- Existing known administrators are explicitly bootstrapped as super admins; future ADMIN users default to OPERATOR.
INSERT INTO "AdminProfile" ("id", "userId", "level", "createdAt", "updatedAt")
SELECT md5(random()::text || clock_timestamp()::text)::uuid, "id", 'SUPER_ADMIN'::"AdminLevel", CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "User"
WHERE "role" = 'ADMIN'::"UserRole"
ON CONFLICT ("userId") DO NOTHING;

-- Add provisional/configurable rider restriction values to all policy versions.
UPDATE "BusinessConfig"
SET "payload" = "payload" || jsonb_build_object(
  'riderDailyFreeCancelLimit', 2,
  'riderCancellationRollingWindowDays', 7,
  'riderCancellationCooldownThreshold', 4,
  'riderWarningCooldownThreshold', 2,
  'riderCancellationCooldownSeconds', 172800,
  'riderWarningCooldownSeconds', 172800
)
WHERE "key" = 'ORDER_POLICY';
