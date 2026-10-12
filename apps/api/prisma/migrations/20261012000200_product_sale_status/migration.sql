CREATE TYPE "ProductSaleStatus" AS ENUM ('ON_SALE', 'SOLD_OUT', 'OFF_SHELF');
ALTER TABLE "Product" ADD COLUMN "saleStatus" "ProductSaleStatus" NOT NULL DEFAULT 'ON_SALE';
-- Historical false meant hidden, never temporarily sold out. Do not touch version or timestamps.
UPDATE "Product" SET "saleStatus" = 'OFF_SHELF' WHERE NOT "isAvailable";
CREATE INDEX "Product_merchantId_saleStatus_idx" ON "Product"("merchantId", "saleStatus");

-- Compatibility for older boolean-only writers; the enum is authoritative for new status writes.
CREATE FUNCTION sync_product_sale_status() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."saleStatus" = 'ON_SALE' AND NOT NEW."isAvailable" THEN
      NEW."saleStatus" := 'OFF_SHELF';
    END IF;
  ELSIF NEW."saleStatus" = OLD."saleStatus" AND NEW."isAvailable" IS DISTINCT FROM OLD."isAvailable" THEN
    NEW."saleStatus" := CASE WHEN NEW."isAvailable" THEN 'ON_SALE'::"ProductSaleStatus" ELSE 'OFF_SHELF'::"ProductSaleStatus" END;
  END IF;
  NEW."isAvailable" := (NEW."saleStatus" = 'ON_SALE');
  RETURN NEW;
END $$;
CREATE TRIGGER "Product_sync_sale_status" BEFORE INSERT OR UPDATE ON "Product"
FOR EACH ROW EXECUTE FUNCTION sync_product_sale_status();
ALTER TABLE "Product" ADD CONSTRAINT "Product_sale_status_available_check" CHECK ("isAvailable" = ("saleStatus" = 'ON_SALE'));

CREATE TABLE "ProductSaleStatusAudit" (
  "id" UUID NOT NULL,
  "productId" UUID NOT NULL,
  "merchantId" UUID NOT NULL,
  "version" INTEGER NOT NULL,
  "previousStatus" "ProductSaleStatus" NOT NULL,
  "newStatus" "ProductSaleStatus" NOT NULL,
  "actorId" UUID NOT NULL,
  "reason" TEXT NOT NULL,
  "source" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ProductSaleStatusAudit_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ProductSaleStatusAudit_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "ProductSaleStatusAudit_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "Merchant"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "ProductSaleStatusAudit_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "ProductSaleStatusAudit_productId_version_key" ON "ProductSaleStatusAudit"("productId", "version");
CREATE INDEX "ProductSaleStatusAudit_merchantId_createdAt_idx" ON "ProductSaleStatusAudit"("merchantId", "createdAt");
