-- CreateTable
CREATE TABLE "RiderEligibility" (
    "riderId" UUID NOT NULL,
    "expectedGraduationAt" TIMESTAMP(3),
    "graduationReminderAt" TIMESTAMP(3),
    "version" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "RiderEligibility_pkey" PRIMARY KEY ("riderId")
);

-- CreateTable
CREATE TABLE "AcademicTerm" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "timeZone" TEXT NOT NULL,
    "startsAt" TIMESTAMP(3) NOT NULL,
    "endsAt" TIMESTAMP(3) NOT NULL,
    "renewalOpensAt" TIMESTAMP(3) NOT NULL,
    "renewalClosesAt" TIMESTAMP(3) NOT NULL,
    "reminderStartsAt" TIMESTAMP(3) NOT NULL,
    "requestKey" UUID NOT NULL,
    "createdById" UUID NOT NULL,
    "reason" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AcademicTerm_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RiderTermQualification" (
    "riderId" UUID NOT NULL,
    "termId" UUID NOT NULL,
    "decision" TEXT NOT NULL,
    "validFrom" TIMESTAMP(3),
    "validUntil" TIMESTAMP(3),
    "reason" TEXT NOT NULL,
    "reviewedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RiderTermQualification_pkey" PRIMARY KEY ("riderId","termId")
);

-- CreateTable
CREATE TABLE "RiderRenewalRequest" (
    "id" UUID NOT NULL,
    "riderId" UUID NOT NULL,
    "termId" UUID NOT NULL,
    "intent" TEXT NOT NULL,
    "requestKey" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RiderRenewalRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RiderEligibilityReview" (
    "id" UUID NOT NULL,
    "riderId" UUID NOT NULL,
    "termId" UUID,
    "actorId" UUID NOT NULL,
    "requestKey" UUID NOT NULL,
    "action" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "request" JSONB NOT NULL,
    "before" JSONB NOT NULL,
    "after" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RiderEligibilityReview_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AcademicTerm_requestKey_key" ON "AcademicTerm"("requestKey");

-- CreateIndex
CREATE UNIQUE INDEX "RiderRenewalRequest_riderId_termId_key" ON "RiderRenewalRequest"("riderId", "termId");

-- CreateIndex
CREATE UNIQUE INDEX "RiderRenewalRequest_riderId_requestKey_key" ON "RiderRenewalRequest"("riderId", "requestKey");

-- CreateIndex
CREATE UNIQUE INDEX "RiderEligibilityReview_riderId_requestKey_key" ON "RiderEligibilityReview"("riderId", "requestKey");

-- CreateIndex
CREATE UNIQUE INDEX "RiderEligibilityReview_riderId_version_key" ON "RiderEligibilityReview"("riderId", "version");

-- AddForeignKey
ALTER TABLE "RiderEligibility" ADD CONSTRAINT "RiderEligibility_riderId_fkey" FOREIGN KEY ("riderId") REFERENCES "Rider"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AcademicTerm" ADD CONSTRAINT "AcademicTerm_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RiderTermQualification" ADD CONSTRAINT "RiderTermQualification_riderId_fkey" FOREIGN KEY ("riderId") REFERENCES "Rider"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RiderTermQualification" ADD CONSTRAINT "RiderTermQualification_termId_fkey" FOREIGN KEY ("termId") REFERENCES "AcademicTerm"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RiderRenewalRequest" ADD CONSTRAINT "RiderRenewalRequest_riderId_fkey" FOREIGN KEY ("riderId") REFERENCES "Rider"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RiderRenewalRequest" ADD CONSTRAINT "RiderRenewalRequest_termId_fkey" FOREIGN KEY ("termId") REFERENCES "AcademicTerm"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RiderEligibilityReview" ADD CONSTRAINT "RiderEligibilityReview_riderId_fkey" FOREIGN KEY ("riderId") REFERENCES "Rider"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RiderEligibilityReview" ADD CONSTRAINT "RiderEligibilityReview_termId_fkey" FOREIGN KEY ("termId") REFERENCES "AcademicTerm"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RiderEligibilityReview" ADD CONSTRAINT "RiderEligibilityReview_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Additive migration: never fabricate student qualification or alter historical orders/money.
ALTER TABLE "AcademicTerm" ADD CONSTRAINT "AcademicTerm_dates_check" CHECK (
  "startsAt" < "endsAt" AND "renewalOpensAt" < "renewalClosesAt"
  AND "reminderStartsAt" <= "renewalOpensAt" AND "renewalClosesAt" <= "endsAt"
);
ALTER TABLE "AcademicTerm" ADD CONSTRAINT "AcademicTerm_no_overlap"
  EXCLUDE USING gist (tsrange("startsAt", "endsAt", '[)') WITH &&);
ALTER TABLE "AcademicTerm" ADD CONSTRAINT "AcademicTerm_windows_no_overlap"
  EXCLUDE USING gist (tsrange("renewalOpensAt", "renewalClosesAt", '[)') WITH &&);
ALTER TABLE "RiderEligibility" ADD CONSTRAINT "RiderEligibility_graduation_check" CHECK (
  ("expectedGraduationAt" IS NULL AND "graduationReminderAt" IS NULL)
  OR ("expectedGraduationAt" IS NOT NULL AND "graduationReminderAt" IS NOT NULL
    AND "graduationReminderAt" <= "expectedGraduationAt")
);
ALTER TABLE "RiderTermQualification" ADD CONSTRAINT "RiderTermQualification_decision_check" CHECK (
  ("decision" = 'APPROVED' AND "validFrom" IS NOT NULL AND "validUntil" IS NOT NULL AND "validFrom" < "validUntil")
  OR ("decision" = 'REJECTED' AND "validFrom" IS NULL AND "validUntil" IS NULL)
);
ALTER TABLE "RiderRenewalRequest" ADD CONSTRAINT "RiderRenewalRequest_intent_check"
  CHECK ("intent" IN ('CONTINUE', 'DECLINE', 'GRADUATE_EXCEPTION'));
