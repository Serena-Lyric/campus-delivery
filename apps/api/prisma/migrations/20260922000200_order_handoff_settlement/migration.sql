-- CreateEnum
CREATE TYPE "DeliveryMethod" AS ENUM ('DESIGNATED_POINT', 'DOOR', 'FACE_TO_FACE');

-- CreateEnum
CREATE TYPE "DeliveryVerificationMode" AS ENUM ('DELIVERY_PHOTO', 'HANDOFF_CODE');

-- CreateEnum
CREATE TYPE "PickupVerificationMode" AS ENUM ('CONFIRMATION', 'PHOTO', 'PICKUP_CODE');

-- CreateEnum
CREATE TYPE "OrderEventType" AS ENUM ('ORDER_CREATED', 'COOLING_OFF_COMPLETED', 'MERCHANT_CONFIRMED', 'READY_FOR_RIDER', 'RIDER_CLAIMED', 'RIDER_ABANDONED', 'PICKED_UP', 'DELIVERED', 'CANCELLED', 'EXCEPTION_RECORDED', 'STATUS_CHANGED');

-- CreateEnum
CREATE TYPE "OrderEventActorType" AS ENUM ('USER', 'SYSTEM');

-- CreateEnum
CREATE TYPE "DeliveryAssignmentStatus" AS ENUM ('ACTIVE', 'ABANDONED', 'COMPLETED', 'EXCEPTION');

-- CreateEnum
CREATE TYPE "RiderSettlementStatus" AS ENUM ('PENDING', 'AVAILABLE', 'HELD');

-- CreateEnum
CREATE TYPE "VerificationPurpose" AS ENUM ('DELIVERY', 'PICKUP');

-- CreateEnum
CREATE TYPE "EvidenceType" AS ENUM ('MERCHANT_HANDOFF_PHOTO', 'RIDER_PICKUP_PHOTO', 'DELIVERY_PHOTO', 'HANDOFF_CODE_VERIFICATION', 'PICKUP_CODE_VERIFICATION');

-- CreateEnum
CREATE TYPE "ExceptionType" AS ENUM ('CUSTOMER_UNREACHABLE', 'WRONG_ADDRESS', 'MERCHANT_DELAY', 'ITEM_MISSING', 'ITEM_DAMAGED', 'RIDER_DELIVERY_EXCEPTION', 'DELIVERY_DISPUTE');

-- AlterEnum
ALTER TYPE "OrderStatus" ADD VALUE 'MERCHANT_PENDING';

-- DropForeignKey
ALTER TABLE "OrderEvent" DROP CONSTRAINT "OrderEvent_operatorId_fkey";

-- AlterTable
ALTER TABLE "CampusLocation" ADD COLUMN     "supportedDeliveryMethods" "DeliveryMethod"[] DEFAULT ARRAY['DESIGNATED_POINT', 'DOOR', 'FACE_TO_FACE']::"DeliveryMethod"[];

-- AlterTable
ALTER TABLE "Merchant" ADD COLUMN     "pickupVerificationMode" "PickupVerificationMode" NOT NULL DEFAULT 'CONFIRMATION',
ADD COLUMN     "supportedDeliveryMethods" "DeliveryMethod"[] DEFAULT ARRAY['DESIGNATED_POINT', 'DOOR', 'FACE_TO_FACE']::"DeliveryMethod"[];

-- AlterTable: add nullable/defaulted columns first so existing orders can be backfilled.
ALTER TABLE "Order" ADD COLUMN     "coolingOffEndsAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "deliveryMethod" "DeliveryMethod" NOT NULL DEFAULT 'DESIGNATED_POINT',
ADD COLUMN     "deliveryVerificationMode" "DeliveryVerificationMode" NOT NULL DEFAULT 'DELIVERY_PHOTO',
ADD COLUMN     "pickupVerificationMode" "PickupVerificationMode" NOT NULL DEFAULT 'CONFIRMATION',
ADD COLUMN     "shortCode" TEXT,
ADD COLUMN     "shortCodeDay" DATE;

UPDATE "Order"
SET "shortCode" = 'LEG' || UPPER(SUBSTRING(REPLACE("id"::text, '-', '') FROM 1 FOR 8)),
    "shortCodeDay" = "createdAt"::date
WHERE "shortCode" IS NULL OR "shortCodeDay" IS NULL;

ALTER TABLE "Order"
ALTER COLUMN "shortCode" SET NOT NULL,
ALTER COLUMN "shortCodeDay" SET NOT NULL,
ALTER COLUMN "coolingOffEndsAt" DROP DEFAULT,
ALTER COLUMN "deliveryMethod" DROP DEFAULT,
ALTER COLUMN "deliveryVerificationMode" DROP DEFAULT,
ALTER COLUMN "pickupVerificationMode" DROP DEFAULT;

-- AlterTable
ALTER TABLE "OrderEvent" ADD COLUMN     "actorType" "OrderEventActorType" NOT NULL DEFAULT 'USER',
ADD COLUMN     "eventType" "OrderEventType" NOT NULL DEFAULT 'STATUS_CHANGED',
ADD COLUMN     "metadata" JSONB,
ALTER COLUMN "operatorId" DROP NOT NULL,
ALTER COLUMN "operatorRole" DROP NOT NULL;

-- AlterTable
ALTER TABLE "Rider" ADD COLUMN     "currentConcurrentOrderLimit" INTEGER NOT NULL DEFAULT 1;

-- CreateTable
CREATE TABLE "DeliveryAssignment" (
    "id" UUID NOT NULL,
    "taskId" UUID NOT NULL,
    "orderId" UUID NOT NULL,
    "riderId" UUID NOT NULL,
    "status" "DeliveryAssignmentStatus" NOT NULL DEFAULT 'ACTIVE',
    "claimedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" TIMESTAMP(3),
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DeliveryAssignment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RiderSettlement" (
    "id" UUID NOT NULL,
    "orderId" UUID NOT NULL,
    "riderId" UUID NOT NULL,
    "amountMinor" INTEGER NOT NULL,
    "status" "RiderSettlementStatus" NOT NULL DEFAULT 'PENDING',
    "pendingUntil" TIMESTAMP(3) NOT NULL,
    "availableAt" TIMESTAMP(3),
    "heldAt" TIMESTAMP(3),
    "holdReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RiderSettlement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VerificationCode" (
    "id" UUID NOT NULL,
    "orderId" UUID NOT NULL,
    "purpose" "VerificationPurpose" NOT NULL,
    "salt" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "issuerId" UUID NOT NULL,
    "verifierId" UUID,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "verifiedAt" TIMESTAMP(3),
    "invalidatedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VerificationCode_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Evidence" (
    "id" UUID NOT NULL,
    "orderId" UUID NOT NULL,
    "actorId" UUID NOT NULL,
    "actorRole" "UserRole" NOT NULL,
    "evidenceType" "EvidenceType" NOT NULL,
    "orderStage" "OrderStatus" NOT NULL,
    "mediaReference" TEXT,
    "note" TEXT,
    "metadata" JSONB,
    "exceptionEventId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Evidence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExceptionEvent" (
    "id" UUID NOT NULL,
    "orderId" UUID NOT NULL,
    "reporterId" UUID NOT NULL,
    "reporterRole" "UserRole" NOT NULL,
    "orderStatus" "OrderStatus" NOT NULL,
    "type" "ExceptionType" NOT NULL,
    "description" TEXT NOT NULL,
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExceptionEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DeliveryAssignment_riderId_status_idx" ON "DeliveryAssignment"("riderId", "status");

-- CreateIndex
CREATE INDEX "DeliveryAssignment_taskId_status_idx" ON "DeliveryAssignment"("taskId", "status");

-- CreateIndex
CREATE INDEX "DeliveryAssignment_orderId_createdAt_idx" ON "DeliveryAssignment"("orderId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "RiderSettlement_orderId_key" ON "RiderSettlement"("orderId");

-- CreateIndex
CREATE INDEX "RiderSettlement_riderId_status_pendingUntil_idx" ON "RiderSettlement"("riderId", "status", "pendingUntil");

-- CreateIndex
CREATE INDEX "VerificationCode_orderId_purpose_createdAt_idx" ON "VerificationCode"("orderId", "purpose", "createdAt");

-- CreateIndex
CREATE INDEX "Evidence_orderId_createdAt_idx" ON "Evidence"("orderId", "createdAt");

-- CreateIndex
CREATE INDEX "Evidence_exceptionEventId_idx" ON "Evidence"("exceptionEventId");

-- CreateIndex
CREATE INDEX "ExceptionEvent_orderId_createdAt_idx" ON "ExceptionEvent"("orderId", "createdAt");

-- CreateIndex
CREATE INDEX "ExceptionEvent_type_resolvedAt_idx" ON "ExceptionEvent"("type", "resolvedAt");

-- CreateIndex
CREATE INDEX "Order_status_coolingOffEndsAt_idx" ON "Order"("status", "coolingOffEndsAt");

-- CreateIndex
CREATE UNIQUE INDEX "Order_shortCodeDay_shortCode_key" ON "Order"("shortCodeDay", "shortCode");

-- AddForeignKey
ALTER TABLE "OrderEvent" ADD CONSTRAINT "OrderEvent_operatorId_fkey" FOREIGN KEY ("operatorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeliveryAssignment" ADD CONSTRAINT "DeliveryAssignment_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "DeliveryTask"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeliveryAssignment" ADD CONSTRAINT "DeliveryAssignment_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeliveryAssignment" ADD CONSTRAINT "DeliveryAssignment_riderId_fkey" FOREIGN KEY ("riderId") REFERENCES "Rider"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RiderSettlement" ADD CONSTRAINT "RiderSettlement_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RiderSettlement" ADD CONSTRAINT "RiderSettlement_riderId_fkey" FOREIGN KEY ("riderId") REFERENCES "Rider"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VerificationCode" ADD CONSTRAINT "VerificationCode_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VerificationCode" ADD CONSTRAINT "VerificationCode_issuerId_fkey" FOREIGN KEY ("issuerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VerificationCode" ADD CONSTRAINT "VerificationCode_verifierId_fkey" FOREIGN KEY ("verifierId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Evidence" ADD CONSTRAINT "Evidence_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Evidence" ADD CONSTRAINT "Evidence_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Evidence" ADD CONSTRAINT "Evidence_exceptionEventId_fkey" FOREIGN KEY ("exceptionEventId") REFERENCES "ExceptionEvent"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExceptionEvent" ADD CONSTRAINT "ExceptionEvent_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExceptionEvent" ADD CONSTRAINT "ExceptionEvent_reporterId_fkey" FOREIGN KEY ("reporterId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
-- Concurrency and value constraints.
ALTER TABLE "Rider" ADD CONSTRAINT "Rider_currentConcurrentOrderLimit_check" CHECK ("currentConcurrentOrderLimit" > 0);
ALTER TABLE "RiderSettlement" ADD CONSTRAINT "RiderSettlement_amountMinor_check" CHECK ("amountMinor" >= 0);
CREATE UNIQUE INDEX "DeliveryAssignment_one_active_per_task" ON "DeliveryAssignment"("taskId") WHERE "status" = 'ACTIVE';
CREATE UNIQUE INDEX "VerificationCode_one_active_per_purpose" ON "VerificationCode"("orderId", "purpose")
  WHERE "verifiedAt" IS NULL AND "invalidatedAt" IS NULL;

-- Preserve responsibility facts for existing claimed, completed, cancelled, or exceptional tasks.
INSERT INTO "DeliveryAssignment" (
  "id", "taskId", "orderId", "riderId", "status", "claimedAt", "endedAt", "createdAt", "updatedAt"
)
SELECT
  md5(random()::text || clock_timestamp()::text)::uuid,
  task."id",
  task."orderId",
  task."riderId",
  CASE
    WHEN task."status" IN ('CLAIMED', 'PICKED_UP') THEN 'ACTIVE'::"DeliveryAssignmentStatus"
    WHEN task."status" = 'COMPLETED' THEN 'COMPLETED'::"DeliveryAssignmentStatus"
    WHEN task."status" = 'EXCEPTION' THEN 'EXCEPTION'::"DeliveryAssignmentStatus"
    ELSE 'ABANDONED'::"DeliveryAssignmentStatus"
  END,
  COALESCE(task."claimedAt", task."createdAt"),
  CASE WHEN task."status" IN ('CLAIMED', 'PICKED_UP') THEN NULL ELSE COALESCE(task."deliveredAt", task."updatedAt") END,
  COALESCE(task."claimedAt", task."createdAt"),
  task."updatedAt"
FROM "DeliveryTask" task
WHERE task."riderId" IS NOT NULL;

-- Historical completed rider income remains available after this migration.
INSERT INTO "RiderSettlement" (
  "id", "orderId", "riderId", "amountMinor", "status", "pendingUntil", "availableAt", "createdAt", "updatedAt"
)
SELECT
  md5(random()::text || clock_timestamp()::text)::uuid,
  task."orderId",
  task."riderId",
  pricing."riderPayoutMinor",
  'AVAILABLE'::"RiderSettlementStatus",
  COALESCE(task."deliveredAt", task."updatedAt"),
  COALESCE(task."deliveredAt", task."updatedAt"),
  COALESCE(task."deliveredAt", task."createdAt"),
  task."updatedAt"
FROM "DeliveryTask" task
JOIN "OrderPricing" pricing ON pricing."orderId" = task."orderId"
WHERE task."status" = 'COMPLETED' AND task."riderId" IS NOT NULL
ON CONFLICT ("orderId") DO NOTHING;

