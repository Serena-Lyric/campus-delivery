-- Add optional predictions without changing any historical delivery or accounting fact.
ALTER TABLE "Order" ADD COLUMN "merchantEstimatedReadyAt" TIMESTAMP(3);
ALTER TABLE "Order" ADD COLUMN "merchantPreparationEstimateVersion" INTEGER NOT NULL DEFAULT 0;
CREATE TABLE "MerchantPreparationEstimateAudit" (
  "id" UUID NOT NULL,
  "orderId" UUID NOT NULL,
  "version" INTEGER NOT NULL,
  "previousEstimatedReadyAt" TIMESTAMP(3),
  "estimatedReadyAt" TIMESTAMP(3) NOT NULL,
  "actorId" UUID NOT NULL,
  "requestKey" UUID NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "MerchantPreparationEstimateAudit_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "MerchantPreparationEstimateAudit_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "MerchantPreparationEstimateAudit_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "MerchantPreparationEstimateAudit_orderId_version_key" ON "MerchantPreparationEstimateAudit"("orderId", "version");
CREATE UNIQUE INDEX "MerchantPreparationEstimateAudit_orderId_requestKey_key" ON "MerchantPreparationEstimateAudit"("orderId", "requestKey");
CREATE FUNCTION prevent_preparation_estimate_overwrite() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Preparation estimate history is append-only'; END;
$$;
CREATE TRIGGER preparation_estimate_append_only BEFORE UPDATE ON "MerchantPreparationEstimateAudit"
FOR EACH ROW EXECUTE FUNCTION prevent_preparation_estimate_overwrite();
