import {
  DeliveryTaskStatus,
  ExceptionType,
  OrderEventActorType,
  OrderEventType,
  OrderStatus,
  Prisma,
  RiderTipEventType,
  type PrismaClient,
} from '@prisma/client';
import type { Actor } from '../auth/auth.js';
import {
  deliveryVerificationFor,
  loadPolicyConfig,
  pickupVerificationFor,
} from '../merchant-policy/policies.js';
import { AppError, badRequest, conflict, forbidden, notFound } from '../shared/errors.js';
import { basisPoints, multiplyMinor } from '../shared/money.js';
import { initializeMerchantPricingForMarket } from '../pricing/service.js';
import { getOrderPricingView } from '../pricing/views.js';
import { assertOrderAccess } from './access.js';
import { generateShortCode, shortCodeDay } from './short-code.js';
import { transitionOrder } from './state-machine.js';
import { openExceptionCase } from '../exception-cases/service.js';
import { DeterministicItemClassifier, classifyItemSafely, type ItemClassifier } from '../item-classifier/classifier.js';
import { pickupRiskSnapshot } from '../delivery/pickup-risk.js';
import { defaultDeliveryPricingPolicy, type DeliveryPricingPolicy } from '../pricing/policy.js';
import { calculateCheckoutQuote, checkoutQuantities, readCheckoutFacts, type CheckoutInput } from './quote.js';

export type CreateOrderInput = CheckoutInput;

const orderInclude = {
  pickupHandoffs: { select: { id: true, assignmentId: true, revision: true, eventId: true, createdAt: true, dispute: { select: { id: true, caseId: true, status: true, version: true, merchantAcknowledgedAt: true } } }, orderBy: { revision: 'desc' as const }, take: 1 },
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

type IncludedOrder = Prisma.OrderGetPayload<{ include: typeof orderInclude }>;

function presentOrder(actor: Actor, order: IncludedOrder, pricing: unknown) {
  const { deliveryTask, settlement, riderSettlement } = order;
  const task = deliveryTask
    ? {
      id: deliveryTask.id,
      orderId: deliveryTask.orderId,
      status: deliveryTask.status,
      riderId: actor.role === 'RIDER' || actor.role === 'ADMIN' ? deliveryTask.riderId : undefined,
      riderGuaranteedPayoutMinor: actor.role === 'RIDER' || actor.role === 'ADMIN' ? deliveryTask.payoutMinor : undefined,
      firstPublishedAt: deliveryTask.firstPublishedAt,
      claimDeadline: deliveryTask.claimDeadline,
      activeAssignmentId: actor.role === 'CUSTOMER' ? undefined : deliveryTask.assignments.find((a) => a.status === 'ACTIVE' && (actor.role !== 'RIDER' || a.riderId === actor.riderId))?.id,
      claimedAt: deliveryTask.claimedAt,
      pickedUpAt: deliveryTask.pickedUpAt,
      deliveredAt: deliveryTask.deliveredAt,
    }
    : null;
  const settlementView = actor.role === 'ADMIN'
    ? settlement
    : actor.role === 'MERCHANT'
      ? settlement && { status: settlement.status, merchantPayableMinor: settlement.merchantPayableMinor }
      : actor.role === 'RIDER'
        ? settlement && { status: settlement.status, riderPayableMinor: settlement.riderPayableMinor }
        : settlement && { status: settlement.status };
  return {
    id: order.id,
    shortCode: order.shortCode,
    coolingOffEndsAt: order.coolingOffEndsAt,
    tipDeadline: order.tipDeadline,
    destinationLabelSnapshot: order.destinationLabelSnapshot,
    deliveryMethod: order.deliveryMethod,
    deliveryVerificationMode: order.deliveryVerificationMode,
    pickupVerificationMode: order.pickupVerificationMode,
    pickupProtocol: actor.role === 'CUSTOMER' ? { confirmationBy: 'MERCHANT' } : { confirmationBy: 'MERCHANT', revision: order.pickupHandoffRevision, handoff: actor.role === 'RIDER' && !deliveryTask?.assignments.some((a) => a.id === order.pickupHandoffs[0]?.assignmentId && a.riderId === actor.riderId) ? null : order.pickupHandoffs[0] ?? null },
    deliveryEvidenceRequired: order.deliveryEvidenceRequired,
    pickupRisk: {
      revision: order.pickupRiskRevision,
      coreFragileValueMinor: order.coreFragileValueMinor,
      evidenceLevel: order.pickupEvidenceLevel,
      policyVersion: order.pickupEvidencePolicyVersion,
      mediaValidation: 'MOCK_REFERENCE_ONLY',
    },
    merchantPreparationStatus: order.merchantPreparationStatus,
    merchantPreparationUpdatedAt: order.merchantPreparationUpdatedAt,
    status: order.status,
    merchant: order.merchant,
    destinationLocation: order.destinationLocation,
    items: order.items.map((item) => ({
      id: item.id,
      productName: item.productNameSnapshot,
      deliveryCategory: {
        code: item.deliveryCategoryCodeSnapshot,
        name: item.deliveryCategoryNameSnapshot,
        version: item.deliveryCategoryVersionSnapshot,
        riskTags: item.deliveryRiskTagsSnapshot,
        coreFragile: item.coreFragileSnapshot,
        reviewRequired: item.deliveryClassificationReviewRequired,
      },
      unitPriceMinor: item.unitPriceMinor,
      quantity: item.quantity,
      subtotalMinor: item.subtotalMinor,
    })),
    events: order.events.map((event) => ({
      id: event.id,
      eventType: event.eventType,
      fromStatus: event.fromStatus,
      toStatus: event.toStatus,
      reason: event.reason,
      createdAt: event.createdAt,
    })),
    createdAt: order.createdAt,
    updatedAt: order.updatedAt,
    pricing,
    deliveryTask: task,
    settlement: settlementView,
    riderSettlement: actor.role === 'RIDER' || actor.role === 'ADMIN'
      ? riderSettlement && {
        id: riderSettlement.id,
        amountMinor: riderSettlement.amountMinor,
        reservedMinor: riderSettlement.reservedMinor,
        withdrawableMinor: Math.max(0, riderSettlement.amountMinor - riderSettlement.reservedMinor),
        status: riderSettlement.status,
        pendingUntil: riderSettlement.pendingUntil,
        availableAt: riderSettlement.availableAt,
        heldAt: riderSettlement.heldAt,
        holdReason: riderSettlement.holdReason,
      }
      : undefined,
  };
}

export async function createOrder(
  prisma: PrismaClient,
  actor: Actor,
  input: CreateOrderInput,
  campusTimeZone: string,
  now = new Date(),
  classifier: ItemClassifier = new DeterministicItemClassifier(),
  pricingPolicy: DeliveryPricingPolicy = defaultDeliveryPricingPolicy,
) {
  if (actor.role !== 'CUSTOMER') throw forbidden();
  const quantities = checkoutQuantities(input);

  const codeDay = shortCodeDay(now, campusTimeZone);

  const productsToClassify = await prisma.product.findMany({
    where: { id: { in: [...quantities.keys()] } },
    include: { category: { select: { name: true } }, deliveryCategory: true },
  });
  if (
    productsToClassify.length !== quantities.size
    || productsToClassify.some((product) => product.merchantId !== input.merchantId || !product.isAvailable)
  ) {
    throw badRequest('INVALID_PRODUCTS', 'Every product must be available from the selected merchant');
  }
  const preclassifiedItems = new Map(await Promise.all(productsToClassify.map(async (product) => [
    product.id,
    {
      facts: {
        merchantId: product.merchantId,
        categoryId: product.categoryId,
        productName: product.name,
        categoryName: product.category.name,
        priceMinor: product.priceMinor,
        isAvailable: product.isAvailable,
        version: product.version,
        deliveryCategory: JSON.stringify(product.deliveryCategory),
      },
      classification: await classifyItemSafely(classifier, {
        productName: product.name,
        merchantCategoryName: product.category.name,
      }),
    },
  ] as const)));

  for (let attempt = 0; attempt < 8; attempt += 1) {
    const shortCode = generateShortCode();
    try {
      return await prisma.$transaction(async (tx) => {
        const facts = await readCheckoutFacts(tx, input, quantities);
        const { version: policyVersion, config, merchant, location, products } = facts;
        const coolingOffEndsAt = new Date(now.getTime() + config.coolingOffSeconds * 1000);
        const tipDeadline = new Date(now.getTime() + config.riderTipWindowSeconds * 1000);
        if (products.some((product) => {
          const before = preclassifiedItems.get(product.id)?.facts;
          return !before
            || before.merchantId !== product.merchantId
            || before.categoryId !== product.categoryId
            || before.productName !== product.name
            || before.categoryName !== product.category.name
            || before.priceMinor !== product.priceMinor
            || before.isAvailable !== product.isAvailable
            || before.version !== product.version
            || before.deliveryCategory !== JSON.stringify(product.deliveryCategory);
        })) {
          throw conflict('PRODUCT_FACTS_CHANGED', 'Product facts changed during classification; retry order creation');
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
          const classification = preclassifiedItems.get(product.id)!.classification;
          return {
            productId: product.id,
            productNameSnapshot: product.name,
            merchantCategoryNameSnapshot: product.category.name,
            deliveryCategoryCodeSnapshot: product.deliveryCategory.code,
            deliveryCategoryNameSnapshot: product.deliveryCategory.name,
            deliveryCategoryVersionSnapshot: product.deliveryCategory.version,
            deliveryRiskTagsSnapshot: product.deliveryCategory.riskTags,
            coreFragileSnapshot: product.deliveryCategory.coreFragile,
            deliveryClassificationReviewRequired: product.deliveryCategory.code === 'UNKNOWN',
            suggestedFoodType: classification.suggestedFoodType,
            handlingTags: classification.handlingTags,
            classificationSource: classification.source,
            classificationVersion: classification.version,
            classificationConfidenceBps: classification.confidenceBps,
            unitPriceMinor: product.priceMinor,
            quantity,
            subtotalMinor: multiplyMinor(product.priceMinor, quantity),
          };
        });
        const { itemSubtotalMinor, deliveryPricing, quoteToken } = calculateCheckoutQuote(
          facts, input, quantities, pricingPolicy, [...new Set(itemData.map((item) => item.suggestedFoodType))],
        );
        if (facts.pricingConfig.config.mode === 'REFERENCE_BPS' && !input.expectedQuoteToken) {
          throw conflict('QUOTE_CONFIRMATION_REQUIRED', 'Preview and confirm the current checkout quote before creating an order');
        }
        if (input.expectedQuoteToken !== undefined && input.expectedQuoteToken !== quoteToken) {
          throw conflict('CHECKOUT_QUOTE_CHANGED', 'Checkout quote changed; preview again and ask the customer to confirm');
        }
        const platformCommissionMinor = basisPoints(itemSubtotalMinor, config.platformCommissionBps);

        return tx.order.create({
          data: {
            shortCode,
            shortCodeDay: codeDay,
            coolingOffEndsAt,
            tipDeadline,
            customerId: actor.id,
            merchantId: merchant.id,
            destinationLocationId: location.id,
            destinationLabelSnapshot: location.name,
            destinationRegionSnapshot: location.regionLabel,
            pickupMerchantNameSnapshot: merchant.name,
            pickupLocationNameSnapshot: merchant.campusLocation.name,
            pickupRegionSnapshot: merchant.campusLocation.regionLabel,
            deliveryMethod: input.deliveryMethod,
            deliveryVerificationMode: deliveryVerificationFor(config, input.deliveryMethod),
            pickupVerificationMode: pickupVerificationFor(merchant.pickupVerificationMode),
            ...pickupRiskSnapshot(itemData, config, policyVersion),
            items: { create: itemData },
            pricing: {
              create: {
                itemSubtotalMinor,
                customerDeliveryFeeMinor: deliveryPricing.customerDeliveryFeeMinor,
                merchantBaseDeliveryPriceMinor: merchant.baseDeliveryPriceMinor,
                riderBasePayoutMinor: deliveryPricing.riderBasePayoutMinor,
                riderGuaranteedPayoutMinor: deliveryPricing.riderBasePayoutMinor,
                riderPayoutMinor: deliveryPricing.riderBasePayoutMinor,
                deliveryPlatformContributionMinor: deliveryPricing.deliveryPlatformContributionMinor,
                platformCommissionMinor,
                merchantSettlementMinor: itemSubtotalMinor - platformCommissionMinor,
                pricingPolicyVersion: policyVersion,
                pricingInputsSnapshot: {
                  ...(deliveryPricing.inputsSnapshot as Prisma.InputJsonObject),
                  merchantBaseQuoteVersion: merchant.baseDeliveryQuoteVersion,
                  orderPolicyVersion: policyVersion,
                  quoteToken,
                  customerConfirmation: input.expectedQuoteToken ? 'PREVIEW_CONFIRMED' : 'LEGACY_DIRECT_CREATION',
                  contract: 'DEVELOPMENT_QUOTE_ONLY',
                },
                pricingReason: deliveryPricing.reason,
              },
            },
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
  return presentOrder(
    actor,
    order,
    await getOrderPricingView(prisma, actor, order.id),
  );
}

export async function listCustomerOrders(prisma: PrismaClient, actor: Actor, limit: number, offset: number) {
  if (actor.role !== 'CUSTOMER') throw forbidden();
  const orders = await prisma.order.findMany({
    where: { customerId: actor.id },
    include: orderInclude,
    orderBy: { createdAt: 'desc' },
    take: limit,
    skip: offset,
  });
  return Promise.all(orders.map(async (order) => presentOrder(
    actor,
    order,
    await getOrderPricingView(prisma, actor, order.id),
  )));
}

export async function confirmOrder(
  prisma: PrismaClient,
  actor: Actor,
  orderId: string,
  now = new Date(),
) {
  if (!actor.merchantId) throw forbidden();
  const { version: policyVersion, config } = await loadPolicyConfig(prisma);

  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "Order" WHERE "id" = ${orderId}::uuid FOR UPDATE`;
    const order = await tx.order.findUnique({
      where: { id: orderId },
      include: { merchant: true, deliveryTask: true },
    });
    if (!order) throw notFound('Order');
    if (order.merchantId !== actor.merchantId) throw forbidden();
    if (order.deliveryTask) throw conflict('ORDER_ALREADY_PUBLISHED', 'Order already has a delivery task');

    await transitionOrder(tx, order.id, order.status, OrderStatus.MERCHANT_CONFIRMED, actor, {
      eventType: OrderEventType.MERCHANT_CONFIRMED,
    });
    const pricing = await initializeMerchantPricingForMarket(tx, order.id, now);
    await transitionOrder(tx, order.id, OrderStatus.MERCHANT_CONFIRMED, OrderStatus.READY_FOR_RIDER, actor, {
      eventType: OrderEventType.READY_FOR_RIDER,
      metadata: { firstPublishedAt: now.toISOString() },
    });
    await tx.order.update({
      where: { id: order.id },
      data: {
        merchantPreparationStatus: 'PREPARING',
        merchantPreparationUpdatedAt: now,
      },
    });
    await tx.deliveryTask.create({
      data: {
        orderId: order.id,
        payoutMinor: pricing.riderGuaranteedPayoutMinor,
        firstPublishedAt: now,
        claimDeadline: new Date(now.getTime() + config.orderClaimWindowSeconds * 1000),
        finalUserWarningAt: new Date(
          now.getTime()
          + (config.orderClaimWindowSeconds - config.finalUserWarningSecondsBeforeClaimDeadline) * 1000,
        ),
        marketPolicyVersion: policyVersion,
        merchantRepriceCooldownSeconds: config.merchantRepriceCooldownSeconds,
        riderSettlementPendingSeconds: config.riderSettlementPendingSeconds,
      },
    });
    return tx.order.findUniqueOrThrow({ where: { id: order.id }, include: orderInclude });
  });
}

export async function markOrderReady(
  prisma: PrismaClient,
  actor: Actor,
  orderId: string,
  now = new Date(),
) {
  if (!actor.merchantId) throw forbidden();
  return prisma.$transaction(async (tx) => {
    const order = await tx.order.findUnique({ where: { id: orderId } });
    if (!order) throw notFound('Order');
    if (order.merchantId !== actor.merchantId) throw forbidden();
    if (order.status !== OrderStatus.READY_FOR_RIDER && order.status !== OrderStatus.CLAIMED) {
      throw conflict('ORDER_STATE_CONFLICT', 'Preparation status can only be updated for a published order before pickup');
    }
    const updated = await tx.order.update({
      where: { id: order.id },
      data: {
        merchantPreparationStatus: 'READY_FOR_PICKUP',
        merchantPreparationUpdatedAt: now,
      },
    });
    await tx.orderEvent.create({
      data: {
        orderId: order.id,
        eventType: OrderEventType.MERCHANT_PREPARATION_UPDATED,
        actorType: OrderEventActorType.USER,
        fromStatus: order.status,
        toStatus: order.status,
        operatorId: actor.id,
        operatorRole: actor.role,
        metadata: { preparationStatus: 'READY_FOR_PICKUP', selfReported: true },
        createdAt: now,
      },
    });
    return updated;
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
    const pricing = await tx.orderPricing.findUniqueOrThrow({ where: { orderId } });
    const refundableTipMinor = pricing.customerRiderTipMinor;
    await tx.orderPricing.update({
      where: { orderId },
      data: {
        customerRefundMinor: pricing.itemSubtotalMinor
          + pricing.customerDeliveryFeeMinor
          + refundableTipMinor,
        customerRiderTipRefundMinor: { increment: refundableTipMinor },
        customerRiderTipMinor: 0,
        riderGuaranteedPayoutMinor: pricing.riderGuaranteedPayoutMinor - refundableTipMinor,
        riderPayoutMinor: pricing.riderPayoutMinor - refundableTipMinor,
      },
    });
    if (refundableTipMinor > 0) {
      await tx.riderTipEvent.create({
        data: {
          orderId,
          customerId: actor.id,
          type: RiderTipEventType.ORDER_CANCELLATION_REFUND,
          deltaMinor: -refundableTipMinor,
          balanceAfterMinor: 0,
          reason: 'COOLING_OFF_CANCELLATION',
          createdAt: now,
        },
      });
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
    const exception = await tx.exceptionEvent.create({
      data: {
        orderId,
        reporterId: actor.id,
        reporterRole: actor.role,
        orderStatus: order.status,
        type: ExceptionType.OTHER_NEEDS_REVIEW,
        description: reason,
      },
    });
    await openExceptionCase(tx, exception);
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
