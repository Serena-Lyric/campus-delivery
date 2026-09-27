-- Backfill defaults from the pricing migration are not runtime defaults.
ALTER TABLE "OrderItem"
  ALTER COLUMN "merchantCategoryNameSnapshot" DROP DEFAULT,
  ALTER COLUMN "suggestedFoodType" DROP DEFAULT,
  ALTER COLUMN "classificationSource" DROP DEFAULT,
  ALTER COLUMN "classificationVersion" DROP DEFAULT,
  ALTER COLUMN "classificationConfidenceBps" DROP DEFAULT;
