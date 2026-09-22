import {
  DeliveryMethod,
  DeliveryTaskStatus,
  MerchantExposureState,
  OrderEventActorType,
  OrderEventType,
  OrderStatus,
  Prisma,
  type PrismaClient,
} from '@prisma/client';
import type { Actor } from '../auth/auth.js';
import {
  calculateSubsidy,
  deliveryVerificationFor,
  exposureForUsage,
  loadPolicyConfig,
  pickupVerificationFor,
} from '../merchant-policy/policies.js';
import { AppError, badRequest, conflict, forbidden, notFound } from '../shared/errors.js';
import { addMinor, basisPoints, multiplyMinor } from '../shared/money.js';
import { assertOrderAccess } from './access.js';
import { generateShortCode, shortCodeDay } from './short-code.js';
import { transitionOrder } from './state-machine.js';

export type CreateOrderInput = {
  merchantId: string;
  destinationLocationId: string;
  deliveryMethod: DeliveryMethod;
  items: Array<{ productId: string; quantity: number }>;
};

const orderInclude = {
  items: true,
  pricing: true,
  settlement: true,
  riderSettlement: true,
  deliveryTask: { include: { assignments: true } },
  assignments: { select: { riderId: true, status: true, claimedAt: true, endedAt: true } },
  events: { orderBy: { createdAt: 'asc' as const } },
  merchant: { select: { id: true, name: true } },
  destinationLocation: { select: { id: true, name: true, type: true } },
} satisfies Prisma.OrderInclude;

export async function createOrder(
  prisma: PrismaClient,
  actor: Actor,
  input: CreateOrderInput,
  campusTimeZone: string,
  now = new Date(),
) {
  if (actor.role !== 'CUSTOMER') throw forbidden();
  if (input.items.length === 0) throw badRequest('EMPTY_ORDER', 'Order must contain at least one item');

  const quantities = new Map<string, number>();
  for (const item of input.items) {
    if (!Number.isSafeInteger(item.quantity) || item.quantity <= 0) {
      throw badRequest('INVALID_QUANTITY', 'Item quantity must be a positive safe integer');
    }
    quantities.set(item.productId, (quantities.get(item.productId) ?? 0) + item.quantity);
  }

  const { config } = await loadPolicyConfig(prisma);
  const codeDay = shortCodeDay(now, campusTimeZone);
  const coolingOffEndsAt = new Date(now.getTime() + config.coolingOffSeconds * 1000);

  for (let attempt = 0; attempt < 8; attempt += 1) {
    const shortCode = generateShortCode();
    try {
      return await prisma.$transaction(async (tx) => {
        const [merchant, location, products] = await Promise.all([
          tx.merchant.findUnique({ where: { id: input.merchantId } }),
          tx.campusLocation.findUnique({ where: { id: input.destinationLocationId } }),
          tx.product.findMany({ where: { id: { in: [...quantities.keys()] } } }),
        ]);
        if (!merchant) throw notFound('Merchant');
        if (!location) throw notFound('Campus location');
        if (!merchant.isOpen || merchant.exposureState === MerchantExposureState.HIDDEN || merchant.exposureState === MerchantExposureState.SUSPENDED) {
          throw conflict('MERCHANT_UNAVAILABLE', 'Merchant is not currently accepting visible orders');
        }
        if (!merchant.supportedDeliveryMethods.includes(input.deliveryMethod)
          || !location.supportedDeliveryMethods.includes(input.deliveryMethod)) {
          throw badRequest('DELIVERY_METHOD_UNAVAILABLE', 'Selected delivery method is not available for this merchant and location');
        }
        if (products.length !== quantities.size || products.some((product) => product.merchantId !== merchant.id || !product.isAvailable)) {
          throw badRequest('INVALID_PRODUCTS', 'Every product must be available from the selected merchant');
        }

        if (merchant.maxConcurrentOrders > 0) {
          const activeOrders = await tx.order.count({
            where: {
              merchantId: merchant.id,
              status: {
                in: [
                  OrderStatus.MERCHANT_PENDING,
                  OrderStatus.MERCHANT_CONFIRMED,
                  OrderStatus.READY_FOR_RIDER,
                  OrderStatus.CLAIMED,
                  OrderStatus.PICKED_UP,
                ],
              },
            },
          });
          if (activeOrders >= merchant.maxConcurrentOrders) {
            throw conflict('MERCHANT_ORDER_LIMIT', 'Merchant has reached its current order limit');
          }
        }

        const itemData = products.map((product) => {
          const quantity = quantities.get(product.id)!;
          return {
            productId: product.id,
            productNameSnapshot: product.name,
            unitPriceMinor: product.priceMinor,
            quantity,
            subtotalMinor: multiplyMinor(product.priceMinor, quantity),
          };
        });
        const itemSubtotalMinor = addMinor(...itemData.map((item) => item.subtotalMinor));

        return tx.order.create({
          data: {
            shortCode,
            shortCodeDay: codeDay,
            coolingOffEndsAt,
            customerId: actor.id,
            merchantId: merchant.id,
            destinationLocationId: location.id,
            destinationLabelSnapshot: location.name,
            deliveryMethod: input.deliveryMethod,
            deliveryVerificationMode: deliveryVerificationFor(config, input.deliveryMethod),
            pickupVerificationMode: pickupVerificationFor(merchant.pickupVerificationMode),
            items: { create: itemData },
            pricing: { create: { itemSubtotalMinor } },
            settlement: { create: {} },
            events: {
              create: {
                eventType: OrderEventType.ORDER_CREATED,
                actorType: OrderEventActorType.USER,
                fromStatus: null,
                toStatus: OrderStatus.CREATED,
                operatorId: actor.id,
                operatorRole: actor.role,
                metadata: { shortCode, coolingOffEndsAt: coolingOffEndsAt.toISOString() },
              },
            },
          },
          include: orderInclude,
        });
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') continue;
      throw error;
    }
  }
  throw conflict('SHORT_CODE_EXHAUSTED', 'Could not allocate a unique short order code');
}

export async function getOrder(prisma: PrismaClient, actor: Actor, orderId: string) {
  const order = await prisma.order.findUnique({ where: { id: orderId }, include: orderInclude });
  if (!order) throw notFound('Order');
  assertOrderAccess(actor, order);
  return order;
}

export async function listCustomerOrders(prisma: PrismaClient, actor: Actor, limit: number, offset: number) {
  if (actor.role !== 'CUSTOMER') throw forbidden();
  return prisma.order.findMany({
    where: { customerId: actor.id },
    include: orderInclude,
    orderBy: { createdAt: 'desc' },
    take: limit,
    skip: offset,
  });
}

export async function confirmOrder(prisma: PrismaClient, actor: Actor, orderId: string) {
  if (!actor.merchantId) throw forbidden();
  return prisma.$transaction(async (tx) => {
    const order = await tx.order.findUnique({ where: { id: orderId } });
    if (!order) throw notFound('Order');
    if (order.merchantId !== actor.merchantId) throw forbidden();
    await transitionOrder(tx, order.id, order.status, OrderStatus.MERCHANT_CONFIRMED, actor, {
      eventType: OrderEventType.MERCHANT_CONFIRMED,
    });
    return tx.order.findUniqueOrThrow({ where: { id: order.id }, include: orderInclude });
  });
}

export async function markOrderReady(prisma: PrismaClient, actor: Actor, orderId: string) {
  if (!actor.merchantId) throw forbidden();
  const { version, config } = await loadPolicyConfig(prisma);

  return prisma.$transaction(async (tx) => {
    const order = await tx.order.findUnique({
      where: { id: orderId },
      include: { merchant: { include: { subsidyAccount: true } }, pricing: true },
    });
    if (!order) throw notFound('Order');
    if (order.merchantId !== actor.merchantId) throw forbidden();
    if (!order.pricing) throw new AppError(500, 'MISSING_PRICING', 'Order pricing is missing');

    await transitionOrder(tx, order.id, order.status, OrderStatus.READY_FOR_RIDER, actor, {
      eventType: OrderEventType.READY_FOR_RIDER,
    });

    if (order.merchant.subsidyAccount) {
      await tx.$queryRaw`SELECT "id" FROM "MerchantSubsidyAccount" WHERE "merchantId" = ${order.merchantId}::uuid FOR UPDATE`;
    }
    const account = await tx.merchantSubsidyAccount.findUnique({ where: { merchantId: order.merchantId } });
    const remainingSubsidyMinor = account ? Math.max(0, account.subsidyLimitMinor - account.subsidyUsedMinor) : 0;
    const platformSubsidyMinor = calculateSubsidy({
      enabled: config.subsidyEnabled,
      targetRiderPayoutMinor: config.targetRiderPayoutMinor,
      customerDeliveryFeeMinor: config.customerDeliveryFeeMinor,
      merchantContributionMinor: order.merchant.deliveryContributionMinor,
      maxSubsidyPerOrderMinor: config.maxSubsidyPerOrderMinor,
      remainingSubsidyMinor,
    });
    const riderPayoutMinor = addMinor(
      config.customerDeliveryFeeMinor,
      order.merchant.deliveryContributionMinor,
      platformSubsidyMinor,
    );
    const platformCommissionMinor = basisPoints(order.pricing.itemSubtotalMinor, config.platformCommissionBps);
    const merchantSettlementMinor = order.pricing.itemSubtotalMinor
      - platformCommissionMinor
      - order.merchant.deliveryContributionMinor;
    if (merchantSettlementMinor < 0) {
      throw new AppError(500, 'INVALID_BUSINESS_CONFIG', 'Configured merchant charges exceed the order subtotal');
    }

    await tx.orderPricing.update({
      where: { orderId: order.id },
      data: {
        customerDeliveryFeeMinor: config.customerDeliveryFeeMinor,
        merchantDeliveryContributionMinor: order.merchant.deliveryContributionMinor,
        platformSubsidyMinor,
        riderPayoutMinor,
        platformCommissionMinor,
        merchantSettlementMinor,
      },
    });
    await tx.deliveryTask.create({ data: { orderId: order.id, payoutMinor: riderPayoutMinor } });

    if (platformSubsidyMinor > 0 && account) {
      const usedMinor = addMinor(account.subsidyUsedMinor, platformSubsidyMinor);
      const exposure = exposureForUsage(usedMinor, account.subsidyLimitMinor, config.exposureThresholds);
      await tx.subsidyRecord.create({
        data: { merchantId: order.merchantId, orderId: order.id, amountMinor: platformSubsidyMinor, policyVersion: version },
      });
      await tx.merchantSubsidyAccount.update({
        where: { id: account.id },
        data: { subsidyUsedMinor: usedMinor, riskScore: exposure.usageBps },
      });
      await tx.merchant.update({ where: { id: order.merchantId }, data: { exposureState: exposure.state } });
    }

    return tx.order.findUniqueOrThrow({ where: { id: order.id }, include: orderInclude });
  });
}

export async function cancelOrder(
  prisma: PrismaClient,
  actor: Actor,
  orderId: string,
  reason?: string,
  now = new Date(),
) {
  if (actor.role !== 'CUSTOMER') throw forbidden();

  return prisma.$transaction(async (tx) => {
    const updated = await tx.order.updateMany({
      where: {
        id: orderId,
        customerId: actor.id,
        status: OrderStatus.CREATED,
        coolingOffEndsAt: { gt: now },
      },
      data: { status: OrderStatus.CANCELLED },
    });
    if (updated.count !== 1) {
      const order = await tx.order.findUnique({ where: { id: orderId } });
      if (!order) throw notFound('Order');
      if (order.customerId !== actor.id) throw forbidden();
      throw conflict('COOLING_OFF_ENDED', 'The cooling-off period has ended; use the exception process');
    }
    await tx.orderEvent.create({
      data: {
        orderId,
        eventType: OrderEventType.CANCELLED,
        actorType: OrderEventActorType.USER,
        fromStatus: OrderStatus.CREATED,
        toStatus: OrderStatus.CANCELLED,
        operatorId: actor.id,
        operatorRole: actor.role,
        ...(reason ? { reason } : {}),
      },
    });
    return tx.order.findUniqueOrThrow({ where: { id: orderId }, include: orderInclude });
  });
}

export async function markOrderException(prisma: PrismaClient, actor: Actor, orderId: string, reason: string) {
  return prisma.$transaction(async (tx) => {
    const order = await tx.order.findUnique({ where: { id: orderId }, include: { deliveryTask: true } });
    if (!order) throw notFound('Order');
    await transitionOrder(tx, order.id, order.status, OrderStatus.EXCEPTION, actor, {
      eventType: OrderEventType.EXCEPTION_RECORDED,
      reason,
    });
    if (order.deliveryTask) {
      await tx.deliveryTask.update({ where: { id: order.deliveryTask.id }, data: { status: DeliveryTaskStatus.EXCEPTION } });
    }
    return tx.order.findUniqueOrThrow({ where: { id: order.id }, include: orderInclude });
  });
}
