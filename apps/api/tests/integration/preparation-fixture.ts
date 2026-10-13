import { PrismaClient } from '@prisma/client';
import { expect } from 'vitest';
import { buildApp } from '../../src/app.js';
import { seedDatabase, seedIds } from '../../prisma/seed.js';

export const requestHeaders = (id: string) => ({ 'x-user-id': id });
export async function preparationFixture() {
  const prisma = new PrismaClient();
  await seedDatabase(prisma);
  const ownerId = (await prisma.user.create({ data: { role: 'MERCHANT', displayName: 'preparation workflow owner' } })).id;
  const merchant = await prisma.merchant.create({ data: { ownerId, name: 'preparation workflow fixture', campusLocationId: seedIds.merchantLocation,
    exposureState: 'NORMAL', categories: { create: { name: 'menu' } } }, include: { categories: true } });
  const productId = (await prisma.product.create({ data: { merchantId: merchant.id, categoryId: merchant.categories[0]!.id,
    name: 'rice', priceMinor: 2000, deliveryCategoryCode: 'ORDINARY_MEAL' } })).id;
  const riders: Array<{ id: string; userId: string }> = [];
  for (let i = 0; i < 2; i++) {
    const user = await prisma.user.create({ data: { role: 'RIDER', displayName: 'preparation workflow rider', rider: { create: { status: 'AVAILABLE', capacityOverride: 5 } } }, include: { rider: true } });
    riders.push({ id: user.rider!.id, userId: user.id });
  }
  const config = { databaseUrl: process.env.DATABASE_URL!, host: '127.0.0.1', port: 3000, enableDevAuth: true, enableBackgroundJobs: false,
    backgroundSweepIntervalMs: 5000, campusTimeZone: 'Asia/Shanghai', logLevel: 'silent' as const };
  const app = await buildApp(config, prisma);
  await app.ready();
  async function clearOrders() {
    await prisma.exceptionCaseAction.deleteMany({ where: { case: { order: { merchantId: merchant.id } } } });
    await prisma.exceptionCase.deleteMany({ where: { order: { merchantId: merchant.id } } });
    await prisma.deliveryTask.deleteMany({ where: { order: { merchantId: merchant.id } } });
    await prisma.order.deleteMany({ where: { merchantId: merchant.id } });
  }
  async function published() {
    const input = { merchantId: merchant.id, destinationLocationId: seedIds.dormLocation, deliveryMethod: 'DESIGNATED_POINT', items: [{ productId, quantity: 1 }] };
    const quote = await app.inject({ method: 'POST', url: '/orders/price-preview', headers: requestHeaders(seedIds.customer), payload: input });
    expect(quote.statusCode, quote.body).toBe(200);
    const created = await app.inject({ method: 'POST', url: '/orders', headers: requestHeaders(seedIds.customer), payload: { ...input, expectedQuoteToken: quote.json().quoteToken } });
    expect(created.statusCode, created.body).toBe(201);
    const orderId = created.json().id as string;
    await prisma.order.update({ where: { id: orderId }, data: { status: 'MERCHANT_PENDING' } });
    const confirmed = await app.inject({ method: 'POST', url: `/merchant/orders/${orderId}/confirm`, headers: requestHeaders(ownerId) });
    expect(confirmed.statusCode, confirmed.body).toBe(200);
    return { orderId, taskId: confirmed.json().deliveryTask.id as string };
  }
  async function claim(taskId: string, user = riders[0]!.userId) {
    return app.inject({ method: 'POST', url: `/delivery-tasks/${taskId}/claim`, headers: requestHeaders(user) });
  }
  async function close() {
    await app.close();
    await clearOrders();
    await prisma.product.deleteMany({ where: { merchantId: merchant.id } });
    await prisma.productCategory.deleteMany({ where: { merchantId: merchant.id } });
    await prisma.merchant.delete({ where: { id: merchant.id } });
    await prisma.user.delete({ where: { id: ownerId } });
    for (const rider of riders) {
      await prisma.riderCancellationEvent.deleteMany({ where: { riderId: rider.id } });
      await prisma.riderRestrictionAudit.deleteMany({ where: { restriction: { riderId: rider.id } } });
      await prisma.riderRestriction.deleteMany({ where: { riderId: rider.id } });
      await prisma.riderCapacityEvent.deleteMany({ where: { riderId: rider.id } });
      await prisma.rider.delete({ where: { id: rider.id } });
      await prisma.user.delete({ where: { id: rider.userId } });
    }
    await prisma.$disconnect();
  }
  return { prisma, app, config, ownerId, merchantId: merchant.id, productId, riders, published, claim, clearOrders, close };
}
