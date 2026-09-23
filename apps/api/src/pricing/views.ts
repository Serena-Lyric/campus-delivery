import type { PrismaClient } from '@prisma/client';
import type { Actor } from '../auth/auth.js';
import { assertOrderAccess } from '../orders/access.js';
import { notFound } from '../shared/errors.js';

export async function getOrderPricingView(prisma: PrismaClient, actor: Actor, orderId: string) {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: {
      pricing: true,
      deliveryTask: { include: { assignments: { orderBy: { claimedAt: 'desc' } } } },
      assignments: { select: { riderId: true } },
      merchantQuoteHistory: { orderBy: { version: 'asc' } },
      riderTipEvents: { orderBy: { createdAt: 'asc' } },
      subsidyRecords: { orderBy: { createdAt: 'asc' } },
    },
  });
  if (!order || !order.pricing) throw notFound('Order pricing');
  assertOrderAccess(actor, order);
  const pricing = order.pricing;

  if (actor.role === 'CUSTOMER') {
    return {
      itemSubtotalMinor: pricing.itemSubtotalMinor,
      customerDeliveryFeeMinor: pricing.customerDeliveryFeeMinor,
      customerRiderTipMinor: pricing.customerRiderTipMinor,
      customerRiderTipRefundMinor: pricing.customerRiderTipRefundMinor,
      customerRefundMinor: pricing.customerRefundMinor,
      tipHistory: order.riderTipEvents.map((event) => ({
        id: event.id,
        type: event.type,
        deltaMinor: event.deltaMinor,
        balanceAfterMinor: event.balanceAfterMinor,
        createdAt: event.createdAt,
      })),
    };
  }

  if (actor.role === 'MERCHANT') {
    return {
      merchantDeliveryQuoteMinor: pricing.merchantDeliveryContributionMinor,
      merchantQuoteVersion: pricing.merchantQuoteVersion,
      merchantQuoteUpdatedAt: pricing.merchantQuoteUpdatedAt,
      quoteHistory: order.merchantQuoteHistory.map((quote) => ({
        id: quote.id,
        version: quote.version,
        previousMinor: quote.previousMinor,
        newMinor: quote.newMinor,
        reason: quote.reason,
        createdAt: quote.createdAt,
      })),
    };
  }

  if (actor.role === 'RIDER') {
    const assignment = order.deliveryTask?.assignments.find(
      (candidate) => candidate.riderId === actor.riderId,
    );
    return {
      guaranteedRiderPayoutMinor: assignment
        ? assignment.riderPayoutMinorAtClaim + assignment.postClaimTipMinor
        : order.deliveryTask?.payoutMinor ?? pricing.riderPayoutMinor,
      preparationStatus: order.merchantPreparationStatus,
      firstPublishedAt: order.deliveryTask?.firstPublishedAt ?? null,
      claimDeadline: order.deliveryTask?.claimDeadline ?? null,
    };
  }

  return {
    pricing,
    quoteHistory: order.merchantQuoteHistory,
    tipHistory: order.riderTipEvents,
    subsidyHistory: order.subsidyRecords,
    assignments: order.deliveryTask?.assignments ?? [],
    task: order.deliveryTask
      ? {
        id: order.deliveryTask.id,
        status: order.deliveryTask.status,
        firstPublishedAt: order.deliveryTask.firstPublishedAt,
        claimDeadline: order.deliveryTask.claimDeadline,
        payoutMinor: order.deliveryTask.payoutMinor,
      }
      : null,
  };
}
