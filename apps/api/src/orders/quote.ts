import { DeliveryMethod, MerchantExposureState, Prisma, type PrismaClient } from '@prisma/client';
import { createHash } from 'node:crypto';
import type { Actor } from '../auth/auth.js';
import { loadPolicyConfig } from '../merchant-policy/policies.js';
import { assertStoredMinor, loadDeliveryPricingConfig, pricingConfigLock } from '../pricing/config.js';
import { defaultDeliveryPricingPolicy, type DeliveryPricingPolicy } from '../pricing/policy.js';
import { badRequest, conflict, forbidden, notFound } from '../shared/errors.js';
import { multiplyMinor } from '../shared/money.js';
import { loadPaymentCostPolicy } from '../finance/costs.js';

export type CheckoutInput = {
  merchantId: string;
  destinationLocationId: string;
  deliveryMethod: DeliveryMethod;
  items: Array<{ productId: string; quantity: number }>;
  expectedQuoteToken?: string;
};

export function checkoutQuantities(input: CheckoutInput) {
  if (!input.items.length || input.items.length > 50) throw badRequest('INVALID_ORDER_ITEMS', 'Order must contain 1..50 lines');
  const quantities = new Map<string, number>();
  for (const item of input.items) {
    if (!Number.isSafeInteger(item.quantity) || item.quantity <= 0 || item.quantity > 99) {
      throw badRequest('INVALID_QUANTITY', 'Line quantity must be an integer between 1 and 99');
    }
    const total = (quantities.get(item.productId) ?? 0) + item.quantity;
    if (total > 99) throw badRequest('INVALID_QUANTITY', 'Combined product quantity cannot exceed 99');
    quantities.set(item.productId, total);
  }
  return quantities;
}

export async function readCheckoutFacts(tx: Prisma.TransactionClient, input: CheckoutInput, quantities: Map<string, number>) {
  // All checkout readers share this lock order: config -> merchant -> catalog -> locations.
  await tx.$executeRaw`SELECT pg_advisory_xact_lock_shared(${pricingConfigLock})`;
  const policy = await loadPolicyConfig(tx);
  const pricingConfig = await loadDeliveryPricingConfig(tx);
  const paymentCostPolicy = await loadPaymentCostPolicy(tx);
  await tx.$queryRaw`SELECT "id" FROM "Merchant" WHERE "id" = ${input.merchantId}::uuid FOR SHARE`;
  const productIds = [...quantities.keys()].sort();
  await tx.$queryRaw`SELECT "id" FROM "Product" WHERE "id" IN (${Prisma.join(productIds.map((id) => Prisma.sql`${id}::uuid`))}) ORDER BY "id" FOR SHARE`;
  const rawProducts = await tx.product.findMany({ where: { id: { in: productIds } } });
  if (rawProducts.length !== quantities.size || rawProducts.some((product) => product.merchantId !== input.merchantId || product.saleStatus !== 'ON_SALE')) {
    throw badRequest('INVALID_PRODUCTS', 'Every product must be available from the selected merchant');
  }
  const categoryCodes = [...new Set(rawProducts.map((product) => product.deliveryCategoryCode))].sort();
  await tx.$queryRaw`SELECT "code" FROM "DeliveryCategory" WHERE "code" IN (${Prisma.join(categoryCodes)}) ORDER BY "code" FOR SHARE`;
  const categoryIds = [...new Set(rawProducts.map((product) => product.categoryId))].sort();
  await tx.$queryRaw`SELECT "id" FROM "ProductCategory" WHERE "id" IN (${Prisma.join(categoryIds.map((id) => Prisma.sql`${id}::uuid`))}) ORDER BY "id" FOR SHARE`;
  const merchantRow = await tx.merchant.findUnique({ where: { id: input.merchantId }, select: { campusLocationId: true } });
  if (!merchantRow) throw notFound('Merchant');
  const locationIds = [...new Set([merchantRow.campusLocationId, input.destinationLocationId])].sort();
  await tx.$queryRaw`SELECT "id" FROM "CampusLocation" WHERE "id" IN (${Prisma.join(locationIds.map((id) => Prisma.sql`${id}::uuid`))}) ORDER BY "id" FOR SHARE`;
  const [merchant, location, products] = await Promise.all([
    tx.merchant.findUniqueOrThrow({ where: { id: input.merchantId }, include: { campusLocation: true } }),
    tx.campusLocation.findUnique({ where: { id: input.destinationLocationId } }),
    tx.product.findMany({ where: { id: { in: productIds } }, include: { category: { select: { name: true } }, deliveryCategory: true }, orderBy: { id: 'asc' } }),
  ]);
  if (!location) throw notFound('Campus location');
  if (!merchant.isOpen || merchant.exposureState === MerchantExposureState.HIDDEN || merchant.exposureState === MerchantExposureState.SUSPENDED) {
    throw conflict('MERCHANT_UNAVAILABLE', 'Merchant is not currently accepting visible orders');
  }
  if (!merchant.supportedDeliveryMethods.includes(input.deliveryMethod) || !location.supportedDeliveryMethods.includes(input.deliveryMethod)) {
    throw badRequest('DELIVERY_METHOD_UNAVAILABLE', 'Selected delivery method is not available for this merchant and location');
  }
  return { ...policy, pricingConfig, paymentCostPolicy, merchant, location, products };
}

export function calculateCheckoutQuote(
  facts: Awaited<ReturnType<typeof readCheckoutFacts>>, input: CheckoutInput, quantities: Map<string, number>,
  pricingPolicy: DeliveryPricingPolicy = defaultDeliveryPricingPolicy,
  suggestedFoodTypes: Parameters<DeliveryPricingPolicy['evaluate']>[0]['suggestedFoodTypes'] = [],
) {
  const { merchant, location, products, config, version, pricingConfig } = facts;
  const items = products.map((product) => ({
    productId: product.id, productName: product.name, unitPriceMinor: product.priceMinor,
    quantity: quantities.get(product.id)!, subtotalMinor: multiplyMinor(product.priceMinor, quantities.get(product.id)!),
  }));
  const itemSubtotalMinor = assertStoredMinor(items.reduce((sum, item) => sum + item.subtotalMinor, 0));
  const deliveryPricing = pricingPolicy.evaluate({
    merchantId: merchant.id, merchantBaseDeliveryPriceMinor: merchant.baseDeliveryPriceMinor,
    merchantCategoryNames: [...new Set(products.map((product) => product.category.name))],
    pickupRegion: merchant.campusLocation.regionLabel, destinationRegion: location.regionLabel,
    suggestedFoodTypes, totalQuantity: items.reduce((sum, item) => sum + item.quantity, 0),
  }, config, pricingConfig);
  const orderTotalMinor = assertStoredMinor(itemSubtotalMinor + deliveryPricing.customerDeliveryFeeMinor);
  // Optimistic confirmation digest, not a payment credential. Covers all displayed prices and contract facts.
  const quoteToken = createHash('sha256').update(JSON.stringify({
    customerContract: 'DEVELOPMENT_QUOTE_V1', merchantId: merchant.id,
    merchantBaseMinor: merchant.baseDeliveryPriceMinor, merchantQuoteVersion: merchant.baseDeliveryQuoteVersion,
    orderPolicyVersion: version, deliveryPolicyVersion: pricingConfig.version,
    pickup: { name: merchant.name, locationId: merchant.campusLocationId, locationName: merchant.campusLocation.name, region: merchant.campusLocation.regionLabel },
    destination: { id: location.id, name: location.name, region: location.regionLabel }, deliveryMethod: input.deliveryMethod,
    items: products.map((product, index) => ({ ...items[index], version: product.version, category: product.category.name, deliveryCategory: product.deliveryCategory })),
    itemSubtotalMinor, customerDeliveryFeeMinor: deliveryPricing.customerDeliveryFeeMinor, orderTotalMinor,
  })).digest('hex');
  return { items, itemSubtotalMinor, orderTotalMinor, deliveryPricing, quoteToken };
}

export async function previewOrderQuote(prisma: PrismaClient, actor: Actor, input: CheckoutInput) {
  if (actor.role !== 'CUSTOMER') throw forbidden();
  const quantities = checkoutQuantities(input);
  return prisma.$transaction(async (tx) => {
    const facts = await readCheckoutFacts(tx, input, quantities);
    const quote = calculateCheckoutQuote(facts, input, quantities);
    return {
      merchantId: input.merchantId, destinationLocationId: input.destinationLocationId, deliveryMethod: input.deliveryMethod,
      items: quote.items, itemSubtotalMinor: quote.itemSubtotalMinor,
      customerDeliveryFeeMinor: quote.deliveryPricing.customerDeliveryFeeMinor, orderTotalMinor: quote.orderTotalMinor,
      quoteToken: quote.quoteToken, quoteConfirmationRequired: facts.pricingConfig.config.mode === 'REFERENCE_BPS',
      contract: 'DEVELOPMENT_QUOTE_ONLY', paymentIntegration: 'NOT_IMPLEMENTED',
    };
  });
}
