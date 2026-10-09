CREATE TABLE "DeliveryCategory" (
 "code" TEXT PRIMARY KEY, "name" TEXT NOT NULL, "version" INTEGER NOT NULL DEFAULT 1,
 "riskTags" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[], "coreFragile" BOOLEAN NOT NULL DEFAULT false,
 "selectable" BOOLEAN NOT NULL DEFAULT true,
 CONSTRAINT "DeliveryCategory_version_check" CHECK ("version" > 0)
);
INSERT INTO "DeliveryCategory" ("code", "name", "riskTags", "coreFragile", "selectable") VALUES
 ('UNKNOWN', '待核定', ARRAY[]::TEXT[], false, false),
 ('CAKE', '蛋糕', ARRAY['CRUSH_RISK','TILT_RISK','COLD_CHAIN'], true, true),
 ('SUNDAE', '圣代/造型冰品', ARRAY['MELT_RISK','TILT_RISK','COLD_CHAIN'], true, true),
 ('DRINK', '普通饮品', ARRAY['SPILL_RISK'], false, true),
 ('SOUP_MEAL', '带汤餐食', ARRAY['SPILL_RISK'], false, true),
 ('ORDINARY_MEAL', '普通餐食', ARRAY[]::TEXT[], false, true);
ALTER TABLE "Product"
 ADD COLUMN "imageUrl" TEXT,
 ADD COLUMN "marketingTags" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
 ADD COLUMN "sortOrder" INTEGER NOT NULL DEFAULT 0,
 ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1,
 ADD COLUMN "deliveryCategoryCode" TEXT NOT NULL DEFAULT 'UNKNOWN',
 ADD CONSTRAINT "Product_deliveryCategoryCode_fkey" FOREIGN KEY ("deliveryCategoryCode") REFERENCES "DeliveryCategory"("code") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "OrderItem"
 ADD COLUMN "deliveryCategoryCodeSnapshot" TEXT NOT NULL DEFAULT 'UNKNOWN',
 ADD COLUMN "deliveryCategoryNameSnapshot" TEXT NOT NULL DEFAULT '待核定',
 ADD COLUMN "deliveryCategoryVersionSnapshot" INTEGER NOT NULL DEFAULT 0,
 ADD COLUMN "deliveryRiskTagsSnapshot" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
 ADD COLUMN "coreFragileSnapshot" BOOLEAN NOT NULL DEFAULT false,
 ADD COLUMN "deliveryClassificationReviewRequired" BOOLEAN NOT NULL DEFAULT true;
-- Historical items remain UNKNOWN. Catalog correction never backfills sold items or money.
