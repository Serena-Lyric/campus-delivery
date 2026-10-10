ALTER TYPE "DeliveryTaskStatus" ADD VALUE 'RISK_REVIEW';
ALTER TYPE "OrderEventType" ADD VALUE 'RIDER_CATALOG_RISK_REPORTED';
ALTER TYPE "OrderEventType" ADD VALUE 'CATALOG_RISK_CORRECTED';
ALTER TYPE "OrderEventType" ADD VALUE 'CATALOG_RISK_REPUBLISHED';
ALTER TABLE "Order" ADD COLUMN "pickupRiskRevision" INTEGER NOT NULL DEFAULT 0;
CREATE TABLE "CatalogRiskReport" (
 "id" UUID PRIMARY KEY, "orderId" UUID NOT NULL, "assignmentId" UUID NOT NULL,
 "orderItemId" UUID NOT NULL, "observedCategoryCode" TEXT NOT NULL, "reason" TEXT NOT NULL,
 "evidenceIds" UUID[] NOT NULL DEFAULT ARRAY[]::UUID[], "originalRiskSnapshot" JSONB NOT NULL,
 "correctedAt" TIMESTAMP(3), "correctedRevision" INTEGER, "republishedAt" TIMESTAMP(3),
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CONSTRAINT "CatalogRiskReport_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE,
 CONSTRAINT "CatalogRiskReport_assignmentId_fkey" FOREIGN KEY ("assignmentId") REFERENCES "DeliveryAssignment"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "CatalogRiskReport_assignmentId_key" ON "CatalogRiskReport"("assignmentId");
CREATE INDEX "CatalogRiskReport_orderId_createdAt_idx" ON "CatalogRiskReport"("orderId", "createdAt");
