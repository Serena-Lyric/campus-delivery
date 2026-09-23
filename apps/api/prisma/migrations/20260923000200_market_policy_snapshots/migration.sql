-- AlterTable
ALTER TABLE "DeliveryTask" ADD COLUMN     "finalUserWarningAt" TIMESTAMP(3),
ADD COLUMN     "marketPolicyVersion" INTEGER,
ADD COLUMN     "merchantRepriceCooldownSeconds" INTEGER;
UPDATE "DeliveryTask" task
SET "marketPolicyVersion" = config."version",
    "merchantRepriceCooldownSeconds" = COALESCE((config."payload"->>'merchantRepriceCooldownSeconds')::integer, 15),
    "finalUserWarningAt" = task."claimDeadline" - make_interval(secs => COALESCE((config."payload"->>'finalUserWarningSecondsBeforeClaimDeadline')::integer, 300))
FROM "BusinessConfig" config
WHERE config."key" = 'ORDER_POLICY' AND config."isActive" = true;

ALTER TABLE "DeliveryTask" ADD CONSTRAINT "DeliveryTask_market_policy_snapshot_check" CHECK (
  "marketPolicyVersion" IS NULL OR "marketPolicyVersion" > 0
) NOT VALID;
ALTER TABLE "DeliveryTask" ADD CONSTRAINT "DeliveryTask_reprice_cooldown_check" CHECK (
  "merchantRepriceCooldownSeconds" IS NULL OR "merchantRepriceCooldownSeconds" >= 0
) NOT VALID;
