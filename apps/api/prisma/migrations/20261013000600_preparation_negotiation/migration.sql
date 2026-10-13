ALTER TABLE "Order" ADD COLUMN "preparationNegotiationVersion" INTEGER NOT NULL DEFAULT 0;
CREATE TABLE "PreparationNegotiationRecord" (
  "id" UUID NOT NULL PRIMARY KEY, "orderId" UUID NOT NULL, "version" INTEGER NOT NULL,
  "kind" TEXT NOT NULL, "actorId" UUID NOT NULL, "actorRole" "UserRole" NOT NULL,
  "proposalVersion" INTEGER, "refundMinor" INTEGER, "text" TEXT NOT NULL, "reviewOutcome" TEXT,
  "requestKey" UUID NOT NULL, "payloadSignature" TEXT NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PreparationNegotiationRecord_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "PreparationNegotiationRecord_money_check" CHECK ("refundMinor" IS NULL OR "refundMinor" >= 0)
);
CREATE UNIQUE INDEX "PreparationNegotiationRecord_orderId_version_key" ON "PreparationNegotiationRecord"("orderId", "version");
CREATE UNIQUE INDEX "PreparationNegotiationRecord_orderId_requestKey_key" ON "PreparationNegotiationRecord"("orderId", "requestKey");
CREATE FUNCTION preserve_preparation_negotiation_history() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Preparation negotiation records are append-only'; END;
$$;
CREATE TRIGGER preserve_preparation_negotiation_history BEFORE UPDATE ON "PreparationNegotiationRecord" FOR EACH ROW EXECUTE FUNCTION preserve_preparation_negotiation_history();
