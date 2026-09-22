import { MerchantExposureState, PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import type { AppConfig } from '../../src/config.js';
import { seedDatabase, seedIds } from '../../prisma/seed.js';

const prisma = new PrismaClient();
const config: AppConfig = {
  databaseUrl: process.env.DATABASE_URL!,
  host: '127.0.0.1',
  port: 3000,
  enableDevAuth: true,
  logLevel: 'silent',
};
const headers = (userId: string) => ({ 'x-user-id': userId });

describe('phase-one order flow', () => {
  let app: Awaited<ReturnType<typeof buildApp>> | undefined;

  beforeAll(async () => {
    await seedDatabase(prisma);
    app = await buildApp(config, prisma);
    await app.ready();
  });

  beforeEach(async () => {
    await prisma.subsidyRecord.deleteMany();
    await prisma.deliveryTask.deleteMany();
    await prisma.order.deleteMany();
    await prisma.merchantSubsidyAccount.update({
      where: { id: seedIds.subsidyAccount },
      data: { subsidyUsedMinor: 0, riskScore: 0, subsidyLimitMinor: 1000 },
    });
    await prisma.merchant.update({
      where: { id: seedIds.merchant },
      data: { exposureState: MerchantExposureState.NORMAL },
    });
  });

  afterAll(async () => {
    if (app) await app.close();
    await prisma.$disconnect();
  });

  it('enforces roles, prevents double claims, and settles a delivered order', async () => {
    if (!app) throw new Error('Test app was not initialized');
    const created = await app.inject({
      method: 'POST',
      url: '/orders',
      headers: headers(seedIds.customer),
      payload: {
        merchantId: seedIds.merchant,
        destinationLocationId: seedIds.dormLocation,
        items: [
          { productId: seedIds.productRice, quantity: 1 },
          { productId: seedIds.productTea, quantity: 1 },
        ],
      },
    });
    expect(created.statusCode).toBe(201);
    const order = created.json();
    expect(order.pricing.itemSubtotalMinor).toBe(2000);

    const forbiddenConfirm = await app.inject({
      method: 'POST',
      url: `/merchant/orders/${order.id}/confirm`,
      headers: headers(seedIds.customer),
    });
    expect(forbiddenConfirm.statusCode).toBe(403);

    const confirmed = await app.inject({
      method: 'POST',
      url: `/merchant/orders/${order.id}/confirm`,
      headers: headers(seedIds.merchantUser),
    });
    expect(confirmed.statusCode).toBe(200);

    const ready = await app.inject({
      method: 'POST',
      url: `/merchant/orders/${order.id}/ready`,
      headers: headers(seedIds.merchantUser),
    });
    expect(ready.statusCode).toBe(200);
    const taskId = ready.json().deliveryTask.id as string;

    const [claimA, claimB] = await Promise.all([
      app.inject({ method: 'POST', url: `/delivery-tasks/${taskId}/claim`, headers: headers(seedIds.riderAUser) }),
      app.inject({ method: 'POST', url: `/delivery-tasks/${taskId}/claim`, headers: headers(seedIds.riderBUser) }),
    ]);
    expect([claimA.statusCode, claimB.statusCode].sort()).toEqual([200, 409]);
    const winningUser = claimA.statusCode === 200 ? seedIds.riderAUser : seedIds.riderBUser;

    const pickedUp = await app.inject({
      method: 'POST',
      url: `/delivery-tasks/${taskId}/pick-up`,
      headers: headers(winningUser),
    });
    expect(pickedUp.statusCode).toBe(200);
    const delivered = await app.inject({
      method: 'POST',
      url: `/delivery-tasks/${taskId}/deliver`,
      headers: headers(winningUser),
    });
    expect(delivered.statusCode).toBe(200);

    const result = await app.inject({
      method: 'GET',
      url: `/orders/${order.id}`,
      headers: headers(seedIds.customer),
    });
    expect(result.statusCode).toBe(200);
    const finalOrder = result.json();
    expect(finalOrder.status).toBe('DELIVERED');
    expect(finalOrder.events.map((event: { toStatus: string }) => event.toStatus)).toEqual([
      'CREATED', 'MERCHANT_CONFIRMED', 'READY_FOR_RIDER', 'CLAIMED', 'PICKED_UP', 'DELIVERED',
    ]);
    expect(finalOrder.pricing).toMatchObject({
      itemSubtotalMinor: 2000,
      customerDeliveryFeeMinor: 0,
      merchantDeliveryContributionMinor: 100,
      platformSubsidyMinor: 200,
      riderPayoutMinor: 300,
      platformCommissionMinor: 100,
      merchantSettlementMinor: 1800,
    });
    expect(finalOrder.settlement).toMatchObject({
      status: 'FINALIZED',
      riderPayableMinor: 300,
      merchantPayableMinor: 1800,
      platformRevenueMinor: -100,
    });
    expect(await prisma.subsidyRecord.count({ where: { orderId: order.id } })).toBe(1);
    expect(await prisma.deliveryTask.count({ where: { id: taskId, riderId: { not: null } } })).toBe(1);
  });
});
