ALTER TYPE "ExceptionType" ADD VALUE 'GOODS_CHANGE_OBJECTION';
CREATE TYPE "ChangeRiskDeclaration" AS ENUM ('NO_ADDITIONAL_CORE_FRAGILE', 'ADDITIONAL_CORE_FRAGILE', 'UNASSESSED');
ALTER TABLE "Order" ADD COLUMN "goodsChangeVersion" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "goodsChangeReviewPending" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "goodsChangeSourceExceptionId" UUID;
CREATE TABLE "OrderChangeNotice" (
  "id" UUID NOT NULL PRIMARY KEY, "orderId" UUID NOT NULL, "version" INTEGER NOT NULL,
  "merchantId" UUID NOT NULL, "merchantNameSnapshot" TEXT NOT NULL, "content" TEXT NOT NULL,
  "riskDeclaration" "ChangeRiskDeclaration" NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "OrderChangeNotice_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "OrderChangeNotice_orderId_version_key" ON "OrderChangeNotice"("orderId", "version");
CREATE TABLE "OrderChangeAcknowledgement" (
  "id" UUID NOT NULL PRIMARY KEY, "noticeId" UUID NOT NULL, "assignmentId" UUID NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "OrderChangeAcknowledgement_noticeId_fkey" FOREIGN KEY ("noticeId") REFERENCES "OrderChangeNotice"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "OrderChangeAcknowledgement_assignmentId_fkey" FOREIGN KEY ("assignmentId") REFERENCES "DeliveryAssignment"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "OrderChangeAcknowledgement_noticeId_assignmentId_key" ON "OrderChangeAcknowledgement"("noticeId", "assignmentId");
CREATE TABLE "GoodsChangeAction" (
  "id" UUID NOT NULL PRIMARY KEY, "orderId" UUID NOT NULL, "version" INTEGER NOT NULL, "action" TEXT NOT NULL,
  "actorId" UUID NOT NULL, "requestKey" UUID NOT NULL, "payloadSignature" TEXT NOT NULL, "noticeId" UUID, "exceptionEventId" UUID,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "GoodsChangeAction_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "GoodsChangeAction_orderId_version_key" ON "GoodsChangeAction"("orderId", "version");
CREATE UNIQUE INDEX "GoodsChangeAction_orderId_requestKey_key" ON "GoodsChangeAction"("orderId", "requestKey");
CREATE FUNCTION preserve_goods_change_history() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Goods change records are append-only'; END;
$$;
CREATE TRIGGER preserve_goods_change_history BEFORE UPDATE ON "OrderChangeNotice" FOR EACH ROW EXECUTE FUNCTION preserve_goods_change_history();
CREATE TRIGGER preserve_goods_change_history BEFORE UPDATE ON "OrderChangeAcknowledgement" FOR EACH ROW EXECUTE FUNCTION preserve_goods_change_history();
CREATE TRIGGER preserve_goods_change_history BEFORE UPDATE ON "GoodsChangeAction" FOR EACH ROW EXECUTE FUNCTION preserve_goods_change_history();
