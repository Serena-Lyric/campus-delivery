CREATE TYPE "NoFaultExitStatus" AS ENUM ('NONE', 'PENDING', 'REJECTED', 'APPROVED');
ALTER TYPE "ExceptionCaseActionType" ADD VALUE 'NOFAULT_EXIT_REQUESTED';
ALTER TYPE "ExceptionCaseActionType" ADD VALUE 'NOFAULT_EXIT_REVIEWED';
ALTER TABLE "DeliveryAssignment"
  ADD COLUMN "temporaryPersonalCapacityRelease" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "noFaultExitStatus" "NoFaultExitStatus" NOT NULL DEFAULT 'NONE';
ALTER TABLE "DeliveryAssignment" ADD CONSTRAINT "DeliveryAssignment_temporary_capacity_check"
  CHECK (NOT "temporaryPersonalCapacityRelease" OR ("status" = 'ACTIVE' AND "noFaultExitStatus" = 'PENDING'));
