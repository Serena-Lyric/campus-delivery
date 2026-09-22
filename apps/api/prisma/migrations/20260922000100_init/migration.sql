-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('CUSTOMER', 'MERCHANT', 'RIDER', 'ADMIN');

-- CreateEnum
CREATE TYPE "CampusLocationType" AS ENUM ('GATE', 'MERCHANT', 'CANTEEN', 'DORMITORY', 'TEACHING_BUILDING', 'OTHER');

-- CreateEnum
CREATE TYPE "MerchantExposureState" AS ENUM ('NORMAL', 'REDUCED', 'LIMITED', 'SEVERELY_LIMITED', 'HIDDEN', 'SUSPENDED');

-- CreateEnum
CREATE TYPE "RiderStatus" AS ENUM ('OFFLINE', 'AVAILABLE', 'SUSPENDED');

-- CreateEnum
CREATE TYPE "OrderStatus" AS ENUM ('CREATED', 'MERCHANT_CONFIRMED', 'READY_FOR_RIDER', 'CLAIMED', 'PICKED_UP', 'DELIVERED', 'CANCELLED', 'EXCEPTION');

-- CreateEnum
CREATE TYPE "DeliveryTaskStatus" AS ENUM ('OPEN', 'CLAIMED', 'PICKED_UP', 'COMPLETED', 'CANCELLED', 'EXCEPTION');

-- CreateEnum
CREATE TYPE "SettlementStatus" AS ENUM ('PENDING', 'FINALIZED');

-- CreateTable
CREATE TABLE "User" (
    "id" UUID NOT NULL,
    "displayName" TEXT NOT NULL,
    "role" "UserRole" NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CampusLocation" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "type" "CampusLocationType" NOT NULL,
    "description" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CampusLocation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Merchant" (
    "id" UUID NOT NULL,
    "ownerId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "campusLocationId" UUID NOT NULL,
    "isOpen" BOOLEAN NOT NULL DEFAULT true,
    "exposureState" "MerchantExposureState" NOT NULL DEFAULT 'NORMAL',
    "maxConcurrentOrders" INTEGER NOT NULL DEFAULT 0,
    "deliveryContributionMinor" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Merchant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProductCategory" (
    "id" UUID NOT NULL,
    "merchantId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProductCategory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Product" (
    "id" UUID NOT NULL,
    "merchantId" UUID NOT NULL,
    "categoryId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "priceMinor" INTEGER NOT NULL,
    "isAvailable" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Product_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Rider" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "status" "RiderStatus" NOT NULL DEFAULT 'OFFLINE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Rider_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Order" (
    "id" UUID NOT NULL,
    "customerId" UUID NOT NULL,
    "merchantId" UUID NOT NULL,
    "destinationLocationId" UUID NOT NULL,
    "destinationLabelSnapshot" TEXT NOT NULL,
    "status" "OrderStatus" NOT NULL DEFAULT 'CREATED',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Order_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrderItem" (
    "id" UUID NOT NULL,
    "orderId" UUID NOT NULL,
    "productId" UUID NOT NULL,
    "productNameSnapshot" TEXT NOT NULL,
    "unitPriceMinor" INTEGER NOT NULL,
    "quantity" INTEGER NOT NULL,
    "subtotalMinor" INTEGER NOT NULL,

    CONSTRAINT "OrderItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrderEvent" (
    "id" UUID NOT NULL,
    "orderId" UUID NOT NULL,
    "fromStatus" "OrderStatus",
    "toStatus" "OrderStatus" NOT NULL,
    "operatorId" UUID NOT NULL,
    "operatorRole" "UserRole" NOT NULL,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OrderEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeliveryTask" (
    "id" UUID NOT NULL,
    "orderId" UUID NOT NULL,
    "status" "DeliveryTaskStatus" NOT NULL DEFAULT 'OPEN',
    "riderId" UUID,
    "payoutMinor" INTEGER NOT NULL,
    "claimedAt" TIMESTAMP(3),
    "pickedUpAt" TIMESTAMP(3),
    "deliveredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DeliveryTask_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrderPricing" (
    "id" UUID NOT NULL,
    "orderId" UUID NOT NULL,
    "itemSubtotalMinor" INTEGER NOT NULL,
    "customerDeliveryFeeMinor" INTEGER NOT NULL DEFAULT 0,
    "merchantDeliveryContributionMinor" INTEGER NOT NULL DEFAULT 0,
    "platformSubsidyMinor" INTEGER NOT NULL DEFAULT 0,
    "riderPayoutMinor" INTEGER NOT NULL DEFAULT 0,
    "platformCommissionMinor" INTEGER NOT NULL DEFAULT 0,
    "merchantSettlementMinor" INTEGER NOT NULL DEFAULT 0,
    "customerRefundMinor" INTEGER NOT NULL DEFAULT 0,
    "exceptionCompensationMinor" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OrderPricing_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Settlement" (
    "id" UUID NOT NULL,
    "orderId" UUID NOT NULL,
    "status" "SettlementStatus" NOT NULL DEFAULT 'PENDING',
    "riderPayableMinor" INTEGER NOT NULL DEFAULT 0,
    "merchantPayableMinor" INTEGER NOT NULL DEFAULT 0,
    "platformRevenueMinor" INTEGER NOT NULL DEFAULT 0,
    "finalizedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Settlement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MerchantSubsidyAccount" (
    "id" UUID NOT NULL,
    "merchantId" UUID NOT NULL,
    "subsidyUsedMinor" INTEGER NOT NULL DEFAULT 0,
    "subsidyLimitMinor" INTEGER NOT NULL DEFAULT 0,
    "riskScore" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MerchantSubsidyAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SubsidyRecord" (
    "id" UUID NOT NULL,
    "merchantId" UUID NOT NULL,
    "orderId" UUID NOT NULL,
    "amountMinor" INTEGER NOT NULL,
    "policyVersion" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SubsidyRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BusinessConfig" (
    "id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "payload" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BusinessConfig_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Merchant_ownerId_key" ON "Merchant"("ownerId");

-- CreateIndex
CREATE INDEX "ProductCategory_merchantId_sortOrder_idx" ON "ProductCategory"("merchantId", "sortOrder");

-- CreateIndex
CREATE UNIQUE INDEX "ProductCategory_merchantId_name_key" ON "ProductCategory"("merchantId", "name");

-- CreateIndex
CREATE INDEX "Product_merchantId_isAvailable_idx" ON "Product"("merchantId", "isAvailable");

-- CreateIndex
CREATE INDEX "Product_categoryId_idx" ON "Product"("categoryId");

-- CreateIndex
CREATE UNIQUE INDEX "Rider_userId_key" ON "Rider"("userId");

-- CreateIndex
CREATE INDEX "Order_customerId_createdAt_idx" ON "Order"("customerId", "createdAt");

-- CreateIndex
CREATE INDEX "Order_merchantId_status_idx" ON "Order"("merchantId", "status");

-- CreateIndex
CREATE INDEX "OrderItem_orderId_idx" ON "OrderItem"("orderId");

-- CreateIndex
CREATE INDEX "OrderEvent_orderId_createdAt_idx" ON "OrderEvent"("orderId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "DeliveryTask_orderId_key" ON "DeliveryTask"("orderId");

-- CreateIndex
CREATE INDEX "DeliveryTask_status_createdAt_idx" ON "DeliveryTask"("status", "createdAt");

-- CreateIndex
CREATE INDEX "DeliveryTask_riderId_status_idx" ON "DeliveryTask"("riderId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "OrderPricing_orderId_key" ON "OrderPricing"("orderId");

-- CreateIndex
CREATE UNIQUE INDEX "Settlement_orderId_key" ON "Settlement"("orderId");

-- CreateIndex
CREATE UNIQUE INDEX "MerchantSubsidyAccount_merchantId_key" ON "MerchantSubsidyAccount"("merchantId");

-- CreateIndex
CREATE UNIQUE INDEX "SubsidyRecord_orderId_key" ON "SubsidyRecord"("orderId");

-- CreateIndex
CREATE INDEX "SubsidyRecord_merchantId_createdAt_idx" ON "SubsidyRecord"("merchantId", "createdAt");

-- CreateIndex
CREATE INDEX "BusinessConfig_key_isActive_version_idx" ON "BusinessConfig"("key", "isActive", "version");

-- CreateIndex
CREATE UNIQUE INDEX "BusinessConfig_key_version_key" ON "BusinessConfig"("key", "version");

-- AddForeignKey
ALTER TABLE "Merchant" ADD CONSTRAINT "Merchant_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Merchant" ADD CONSTRAINT "Merchant_campusLocationId_fkey" FOREIGN KEY ("campusLocationId") REFERENCES "CampusLocation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductCategory" ADD CONSTRAINT "ProductCategory_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "Merchant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Product" ADD CONSTRAINT "Product_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "Merchant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Product" ADD CONSTRAINT "Product_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "ProductCategory"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Rider" ADD CONSTRAINT "Rider_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "Merchant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_destinationLocationId_fkey" FOREIGN KEY ("destinationLocationId") REFERENCES "CampusLocation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderItem" ADD CONSTRAINT "OrderItem_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderItem" ADD CONSTRAINT "OrderItem_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderEvent" ADD CONSTRAINT "OrderEvent_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderEvent" ADD CONSTRAINT "OrderEvent_operatorId_fkey" FOREIGN KEY ("operatorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeliveryTask" ADD CONSTRAINT "DeliveryTask_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeliveryTask" ADD CONSTRAINT "DeliveryTask_riderId_fkey" FOREIGN KEY ("riderId") REFERENCES "Rider"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderPricing" ADD CONSTRAINT "OrderPricing_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Settlement" ADD CONSTRAINT "Settlement_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MerchantSubsidyAccount" ADD CONSTRAINT "MerchantSubsidyAccount_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "Merchant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SubsidyRecord" ADD CONSTRAINT "SubsidyRecord_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "Merchant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SubsidyRecord" ADD CONSTRAINT "SubsidyRecord_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Domain constraints: monetary inputs are non-negative integer minor units.
ALTER TABLE "Merchant" ADD CONSTRAINT "Merchant_limits_check" CHECK ("maxConcurrentOrders" >= 0 AND "deliveryContributionMinor" >= 0);
ALTER TABLE "Product" ADD CONSTRAINT "Product_priceMinor_check" CHECK ("priceMinor" >= 0);
ALTER TABLE "OrderItem" ADD CONSTRAINT "OrderItem_amounts_check" CHECK ("unitPriceMinor" >= 0 AND "quantity" > 0 AND "subtotalMinor" >= 0);
ALTER TABLE "DeliveryTask" ADD CONSTRAINT "DeliveryTask_payoutMinor_check" CHECK ("payoutMinor" >= 0);
ALTER TABLE "OrderPricing" ADD CONSTRAINT "OrderPricing_amounts_check" CHECK (
  "itemSubtotalMinor" >= 0 AND
  "customerDeliveryFeeMinor" >= 0 AND
  "merchantDeliveryContributionMinor" >= 0 AND
  "platformSubsidyMinor" >= 0 AND
  "riderPayoutMinor" >= 0 AND
  "platformCommissionMinor" >= 0 AND
  "merchantSettlementMinor" >= 0 AND
  "customerRefundMinor" >= 0 AND
  "exceptionCompensationMinor" >= 0
);
ALTER TABLE "Settlement" ADD CONSTRAINT "Settlement_payables_check" CHECK ("riderPayableMinor" >= 0 AND "merchantPayableMinor" >= 0);
ALTER TABLE "MerchantSubsidyAccount" ADD CONSTRAINT "MerchantSubsidyAccount_values_check" CHECK (
  "subsidyUsedMinor" >= 0 AND "subsidyLimitMinor" >= 0 AND "riskScore" BETWEEN 0 AND 10000
);
ALTER TABLE "SubsidyRecord" ADD CONSTRAINT "SubsidyRecord_values_check" CHECK ("amountMinor" > 0 AND "policyVersion" > 0);
ALTER TABLE "BusinessConfig" ADD CONSTRAINT "BusinessConfig_version_check" CHECK ("version" > 0);
