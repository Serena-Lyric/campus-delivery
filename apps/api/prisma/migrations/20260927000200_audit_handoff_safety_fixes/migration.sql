-- Pre-production safety correction: neutralize the active, unconfirmed item commission default.
UPDATE "BusinessConfig"
SET "payload" = jsonb_set("payload", '{platformCommissionBps}', '0'::jsonb, true)
WHERE "key" = 'ORDER_POLICY' AND "isActive" = true;

-- Existing riders with a provable normal delivery must not restart in the tutorial stage.
UPDATE "Rider" rider
SET "firstNormalDeliveredAt" = history."firstNormalDeliveredAt"
FROM (
  SELECT assignment."riderId", MIN(task."deliveredAt") AS "firstNormalDeliveredAt"
  FROM "DeliveryAssignment" assignment
  JOIN "DeliveryTask" task
    ON task."id" = assignment."taskId"
   AND task."orderId" = assignment."orderId"
  JOIN "Order" orders ON orders."id" = assignment."orderId"
  WHERE assignment."status" = 'COMPLETED'
    AND task."status" = 'COMPLETED'
    AND task."deliveredAt" IS NOT NULL
    AND orders."status" = 'DELIVERED'
  GROUP BY assignment."riderId"
) history
WHERE rider."id" = history."riderId"
  AND rider."firstNormalDeliveredAt" IS NULL;
