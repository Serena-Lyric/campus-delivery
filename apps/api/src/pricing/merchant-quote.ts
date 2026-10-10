import type { PrismaClient } from '@prisma/client';
import type { Actor } from '../auth/auth.js';
import { badRequest, conflict, forbidden, notFound } from '../shared/errors.js';
import { assertStoredMinor, fallbackQuoteLimitMinor, loadDeliveryPricingConfig, maxStoredMinor, pricingConfigLock } from './config.js';

export const futureQuoteNotice = '仅对后续订单生效，已付款订单不变';
const quoteSelect = { id: true, baseDeliveryPriceMinor: true, baseDeliveryQuoteVersion: true } as const;

function ownMerchantId(actor: Actor) {
  if (actor.role !== 'MERCHANT' || !actor.merchantId) throw forbidden();
  return actor.merchantId;
}

export async function getMerchantBaseQuote(prisma: PrismaClient, actor: Actor) {
  const merchantId = ownMerchantId(actor);
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock_shared(${pricingConfigLock})`;
    await tx.$queryRaw`SELECT "id" FROM "Merchant" WHERE "id" = ${merchantId}::uuid FOR SHARE`;
    const merchant = await tx.merchant.findFirst({ where: { id: merchantId, ownerId: actor.id }, select: quoteSelect });
    if (!merchant) throw notFound('Own merchant');
    const policy = await loadDeliveryPricingConfig(tx);
    const history = await tx.merchantBaseDeliveryQuoteAudit.findMany({
      where: { merchantId }, orderBy: { version: 'desc' }, take: 100,
      select: { version: true, previousMinor: true, newMinor: true, actorId: true, reason: true, createdAt: true },
    });
    return { ...merchant, maxBaseDeliveryPriceMinor: policy.config.mode === 'REFERENCE_BPS' ? policy.config.maxMerchantBaseMinor : fallbackQuoteLimitMinor, notice: futureQuoteNotice, history };
  });
}

export async function updateMerchantBaseQuote(
  prisma: PrismaClient, actor: Actor,
  input: { baseDeliveryPriceMinor: number; expectedVersion: number; reason: string },
) {
  const merchantId = ownMerchantId(actor);
  const value = assertStoredMinor(input.baseDeliveryPriceMinor);
  if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 0 || input.expectedVersion >= maxStoredMinor) {
    throw badRequest('INVALID_QUOTE_VERSION', 'A valid expected quote version is required');
  }
  if (typeof input.reason !== 'string' || !input.reason.trim() || input.reason.length > 500) {
    throw badRequest('QUOTE_REASON_REQUIRED', 'A non-blank audit reason of at most 500 characters is required');
  }
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock_shared(${pricingConfigLock})`;
    const policy = await loadDeliveryPricingConfig(tx);
    const limit = policy.config.mode === 'REFERENCE_BPS' ? policy.config.maxMerchantBaseMinor : fallbackQuoteLimitMinor;
    if (value > limit) throw badRequest('MERCHANT_QUOTE_OUT_OF_RANGE', 'Quote exceeds the configured engineering safety limit');
    await tx.$queryRaw`SELECT "id" FROM "Merchant" WHERE "id" = ${merchantId}::uuid FOR UPDATE`;
    const before = await tx.merchant.findFirst({ where: { id: merchantId, ownerId: actor.id }, select: quoteSelect });
    if (!before) throw notFound('Own merchant');
    const changed = await tx.merchant.updateMany({
      where: { id: merchantId, ownerId: actor.id, baseDeliveryQuoteVersion: input.expectedVersion },
      data: { baseDeliveryPriceMinor: value, baseDeliveryQuoteVersion: { increment: 1 } },
    });
    if (changed.count !== 1) throw conflict('MERCHANT_QUOTE_VERSION_CONFLICT', 'Refresh your own quote before editing');
    const audit = await tx.merchantBaseDeliveryQuoteAudit.create({
      data: { merchantId, version: input.expectedVersion + 1, previousMinor: before.baseDeliveryPriceMinor, newMinor: value, actorId: actor.id, reason: input.reason.trim() },
      select: { version: true, previousMinor: true, newMinor: true, actorId: true, reason: true, createdAt: true },
    });
    return { id: merchantId, baseDeliveryPriceMinor: value, baseDeliveryQuoteVersion: audit.version, notice: futureQuoteNotice, audit };
  });
}
