ALTER TYPE "OrderEventType" ADD VALUE 'RIDER_ARRIVED';
ALTER TABLE "DeliveryAssignment" ADD COLUMN "merchantArrivedAt" TIMESTAMP(3);
CREATE FUNCTION preserve_rider_arrival() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."merchantArrivedAt" IS NOT NULL AND NEW."merchantArrivedAt" IS DISTINCT FROM OLD."merchantArrivedAt" THEN
    RAISE EXCEPTION 'A rider arrival record cannot be overwritten';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER preserve_rider_arrival BEFORE UPDATE ON "DeliveryAssignment"
FOR EACH ROW EXECUTE FUNCTION preserve_rider_arrival();
