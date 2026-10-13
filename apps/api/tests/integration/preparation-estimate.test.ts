import { DeliveryMethod, PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { confirmRiderPickup } from '../../src/delivery/merchant-pickup.js';
import { updatePreparationEstimate } from '../../src/orders/preparation-estimate.js';
import { demoPolicy, seedDatabase, seedIds } from '../../prisma/seed.js';

const prisma = new PrismaClient();
const headers = (id: string) => ({ 'x-user-id': id });
const config = { databaseUrl: process.env.DATABASE_URL!, host: '127.0.0.1', port: 3000,
  enableDevAuth: true, enableBackgroundJobs: false, backgroundSweepIntervalMs: 5000,
  campusTimeZone: 'Asia/Shanghai', logLevel: 'silent' as const };

function signal() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}
async function waitForOrderLock() {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const rows = await prisma.$queryRaw<Array<{ waiting: boolean }>>`SELECT EXISTS(SELECT 1 FROM pg_stat_activity
      WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%"Order"%') AS waiting`;
    if (rows[0]?.waiting) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('No actual PostgreSQL order lock wait observed');
}

describe('voluntary preparation estimates preserve the delivery contract', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let ownerId: string;
  let merchantId: string;
  let productId: string;
  let orderId: string;
  let riderUserId: string;
  let riderId: string;

  beforeAll(async () => {
    await seedDatabase(prisma);
    ownerId = (await prisma.user.create({ data: { role: 'MERCHANT', displayName: 'estimate owner' } })).id;
    const merchant = await prisma.merchant.create({ data: { ownerId, name: 'estimate stall',
      campusLocationId: seedIds.merchantLocation, exposureState: 'NORMAL',
      categories: { create: { name: 'menu' } } }, include: { categories: true } });
    merchantId = merchant.id;
    const rider = await prisma.user.create({ data: { role: 'RIDER', displayName: 'estimate rider', rider: { create: { status: 'AVAILABLE', capacityOverride: 10 } } }, include: { rider: true } });
    riderUserId = rider.id;
    riderId = rider.rider!.id;
    productId = (await prisma.product.create({ data: { merchantId, categoryId: merchant.categories[0]!.id,
      name: 'rice', priceMinor: 2000, deliveryCategoryCode: 'ORDINARY_MEAL' } })).id;
    app = await buildApp(config, prisma);
    await app.ready();
  });
  beforeEach(async () => {
    await prisma.businessConfig.update({ where: { id: seedIds.policyConfig }, data: { payload: demoPolicy, isActive: true } });
    const created = await app.inject({ method: 'POST', url: '/orders', headers: headers(seedIds.customer),
      payload: { merchantId, destinationLocationId: seedIds.dormLocation,
        deliveryMethod: DeliveryMethod.DESIGNATED_POINT, items: [{ productId, quantity: 1 }] } });
    expect(created.statusCode, created.body).toBe(201);
    orderId = created.json().id;
    // Fixture only: the cooling timer is covered by the existing lifecycle suite.
    await prisma.order.update({ where: { id: orderId }, data: { status: 'MERCHANT_PENDING' } });
  });
  afterAll(async () => {
    await app.close();
    await prisma.deliveryTask.deleteMany({ where: { order: { merchantId } } });
    await prisma.order.deleteMany({ where: { merchantId } });
    await prisma.product.deleteMany({ where: { merchantId } });
    await prisma.productCategory.deleteMany({ where: { merchantId } });
    await prisma.merchant.delete({ where: { id: merchantId } });
    await prisma.user.delete({ where: { id: ownerId } });
    await prisma.riderCapacityEvent.deleteMany({ where: { riderId } });
    await prisma.rider.delete({ where: { id: riderId } });
    await prisma.user.delete({ where: { id: riderUserId } });
    await prisma.$disconnect();
  });

  const read = (user = ownerId) => app.inject({ method: 'GET', url: `/orders/${orderId}`, headers: headers(user) });
  const confirm = () => app.inject({ method: 'POST', url: `/merchant/orders/${orderId}/confirm`, headers: headers(ownerId) });
  const write = (estimatedReadyAt: string, expectedVersion = 0, requestKey = randomUUID(), user = ownerId, extra = {}) =>
    app.inject({ method: 'PUT', url: `/merchant/orders/${orderId}/preparation-estimate`, headers: headers(user),
      payload: { estimatedReadyAt, expectedVersion, requestKey, ...extra } });
  const history = (user = ownerId) => app.inject({ method: 'GET', url: `/orders/${orderId}/preparation-estimates`, headers: headers(user) });

  it('defaults to no estimate and permits ordinary publication without one', async () => {
    expect((await read()).json().preparationEstimate).toMatchObject({ estimatedReadyAt: null, version: 0, overdue: false, updateReminder: false, timeZone: 'Asia/Shanghai' });
    expect((await write(new Date(Date.now() + 60_000).toISOString())).statusCode).toBe(409);
    expect((await confirm()).statusCode).toBe(200);
    expect((await read(seedIds.customer)).json().preparationEstimate).toMatchObject({ estimatedReadyAt: null, overdue: false });
    expect((await history()).json()).toEqual([]);
  });

  it('appends earlier and later estimates with UTC timestamps and keeps all market, risk and price facts', async () => {
    await confirm();
    const before = await prisma.order.findUniqueOrThrow({ where: { id: orderId }, include: { deliveryTask: true, pricing: true, items: true } });
    const times = ['2030-01-01T12:00:00+08:00', '2030-01-01T11:00:00+08:00', '2030-01-01T13:00:00+08:00'];
    for (const [version, time] of times.entries()) {
      const result = await write(time, version);
      expect(result.statusCode, result.body).toBe(200);
      expect(result.json().preparationEstimate).toMatchObject({ version: version + 1, overdue: false });
    }
    const rows = (await history()).json();
    expect(rows.map((r: { estimatedReadyAt: string }) => r.estimatedReadyAt)).toEqual(['2030-01-01T04:00:00.000Z', '2030-01-01T03:00:00.000Z', '2030-01-01T05:00:00.000Z']);
    expect(rows.map((r: { previousEstimatedReadyAt: string | null }) => r.previousEstimatedReadyAt)).toEqual([null, '2030-01-01T04:00:00.000Z', '2030-01-01T03:00:00.000Z']);
    expect(rows.every((r: { actorId: string; createdAt: string }) => r.actorId === ownerId && Number.isFinite(Date.parse(r.createdAt)))).toBe(true);
    const after = await prisma.order.findUniqueOrThrow({ where: { id: orderId }, include: { deliveryTask: true, pricing: true, items: true } });
    const contract = (value: object) => Object.fromEntries(Object.entries(value).filter(([key]) => !['merchantEstimatedReadyAt', 'merchantPreparationEstimateVersion', 'updatedAt'].includes(key)));
    expect(contract(after)).toEqual(contract(before));
    expect(await prisma.orderEvent.count({ where: { orderId, eventType: 'MERCHANT_PREPARATION_UPDATED' } })).toBe(3);
    expect(before.deliveryTask!.claimDeadline!.getTime() - before.deliveryTask!.firstPublishedAt!.getTime()).toBe(2_400_000);
  });

  it('makes a retry idempotent, rejects changed reuse and admits one concurrent version update', async () => {
    await confirm();
    const time = '2030-01-01T04:00:00Z';
    const key = randomUUID();
    const responses = await Promise.all([write(time, 0, key), write(time, 0, key)]);
    expect(responses.map((r) => r.statusCode)).toEqual([200, 200]);
    expect((await history()).json()).toHaveLength(1);
    expect((await write('2030-01-01T05:00:00Z', 0, key)).statusCode).toBe(409);
    expect((await write(time, 0)).statusCode).toBe(409);
    const competing = await Promise.all([write('2030-01-01T06:00:00Z', 1), write('2030-01-01T07:00:00Z', 1)]);
    expect(competing.map((r) => r.statusCode).sort()).toEqual([200, 409]);
    expect((await history()).json()).toHaveLength(2);
    expect(await prisma.orderEvent.count({ where: { orderId, eventType: 'MERCHANT_PREPARATION_UPDATED' } })).toBe(2);
  });

  it('retains a past prediction as overdue and clears the reminder only through merchant READY', async () => {
    await confirm();
    const past = '2020-01-01T00:00:00Z';
    expect((await write(past)).statusCode).toBe(200);
    expect((await read()).json().preparationEstimate).toMatchObject({ estimatedReadyAt: '2020-01-01T00:00:00.000Z', overdue: true, updateReminder: true });
    expect((await read(seedIds.customer)).json().preparationEstimate).toMatchObject({ overdue: true, updateReminder: false });
    const pool = await app.inject({ method: 'GET', url: '/delivery-tasks/available', headers: headers(seedIds.riderAUser) });
    expect(pool.json().find((t: { orderId: string }) => t.orderId === orderId).preparationEstimate).toMatchObject({ overdue: true });
    expect((await read()).json().merchantPreparationStatus).toBe('PREPARING');
    expect((await app.inject({ method: 'POST', url: `/merchant/orders/${orderId}/ready`, headers: headers(ownerId) })).statusCode).toBe(200);
    expect((await read()).json().preparationEstimate).toMatchObject({ estimatedReadyAt: '2020-01-01T00:00:00.000Z', overdue: false, updateReminder: false });
    const task = await prisma.deliveryTask.findUniqueOrThrow({ where: { orderId } });
    await prisma.deliveryTask.update({ where: { id: task.id }, data: { status: 'COMPLETED', deliveredAt: new Date() } });
    await prisma.order.update({ where: { id: orderId }, data: { status: 'DELIVERED' } });
    expect((await write(past, 1)).statusCode).toBe(409);
    expect((await history()).json()).toHaveLength(1);
  });

  it('rejects cross-store, unrelated actors, malformed or extra fields without writing history', async () => {
    await confirm();
    const future = '2030-01-01T04:00:00Z';
    for (const actor of [seedIds.customer, seedIds.riderAUser, seedIds.admin, seedIds.merchantUser]) {
      expect((await write(future, 0, randomUUID(), actor)).statusCode).toBe(403);
    }
    for (const extra of [{ merchantId }, { operatorId: ownerId }, { status: 'READY_FOR_PICKUP' }, { createdAt: future }, { claimDeadline: future }, { subsidy: 100 }]) {
      expect((await write(future, 0, randomUUID(), ownerId, extra)).statusCode).toBe(400);
    }
    for (const invalid of ['2030-01-01T04:00:00', '2030-02-30T04:00:00Z', 'invalid', '2030-01-01T25:00:00Z']) expect((await write(invalid)).statusCode).toBe(400);
    expect((await history()).json()).toEqual([]);
    expect((await history(seedIds.merchantUser)).statusCode).toBe(403);
    expect((await history(seedIds.riderAUser)).statusCode).toBe(403);
    expect((await read(seedIds.riderAUser)).statusCode).toBe(403);
  });

  it('validates raw field types before Fastify can coerce them', async () => {
    await confirm();
    const response = await app.inject({ method: 'PUT', url: `/merchant/orders/${orderId}/preparation-estimate`, headers: headers(ownerId),
      payload: { estimatedReadyAt: '2030-01-01T04:00:00Z', expectedVersion: '0', requestKey: randomUUID() } });
    expect(response.statusCode).toBe(400);
    expect((await history()).json()).toEqual([]);
  });

  it('rejects rollover midnight and impossible calendar dates', async () => {
    await confirm();
    for (const time of ['2030-01-01T24:00:00Z', '2027-02-29T12:00:00Z', '0000-01-01T12:00:00Z']) {
      expect((await write(time)).statusCode, time).toBe(400);
    }
    expect((await write('2028-02-29T12:00:00+08:00')).statusCode).toBe(200);
  });

  it('keeps full customer/rider serialized responses free of private audit and pricing fields', async () => {
    await confirm();
    await write('2020-01-01T00:00:00Z');
    const task = await prisma.deliveryTask.findUniqueOrThrow({ where: { orderId } });
    const claim = await app.inject({ method: 'POST', url: `/delivery-tasks/${task.id}/claim`, headers: headers(riderUserId) });
    expect(claim.statusCode, claim.body).toBe(200);
    const customerView = (await read(seedIds.customer)).json();
    const riderView = (await read(riderUserId)).json();
    const myOrders = await app.inject({ method: 'GET', url: '/orders/my', headers: headers(seedIds.customer) });
    const myTasks = await app.inject({ method: 'GET', url: '/delivery-tasks/mine', headers: headers(riderUserId) });
    const riderHistory = await history(riderUserId);
    expect(riderHistory.statusCode).toBe(200);
    expect(riderView.preparationEstimate).toMatchObject({ overdue: true, updateReminder: false });
    expect(myOrders.json().find((o: { id: string }) => o.id === orderId).preparationEstimate.overdue).toBe(true);
    expect(myTasks.json().find((t: { orderId: string }) => t.orderId === orderId).preparationEstimate.overdue).toBe(true);
    const banned = new Set(['actorId', 'operatorId', 'requestKey', 'customerId', 'ownerId', 'merchantRescueContributionMinor', 'platformSubsidyMinor', 'deliveryPlatformContributionMinor', 'pricingInputsSnapshot', 'subsidyRecords', 'merchantPreparationEstimateVersion', 'merchantEstimatedReadyAt']);
    function assertPrivateFieldsAbsent(value: unknown) {
      if (!value || typeof value !== 'object') return;
      for (const [key, child] of Object.entries(value)) {
        expect(banned.has(key), key).toBe(false);
        assertPrivateFieldsAbsent(child);
      }
    }
    for (const value of [customerView, riderView, myOrders.json(), myTasks.json(), riderHistory.json(), (await history(seedIds.customer)).json()]) assertPrivateFieldsAbsent(value);
    expect(Object.keys(riderHistory.json()[0]).sort()).toEqual(['createdAt', 'estimatedReadyAt', 'previousEstimatedReadyAt', 'version']);
    // Former assignments retain ordinary historical access, but receive no live prediction/history.
    await prisma.deliveryAssignment.updateMany({ where: { orderId, riderId }, data: { status: 'ABANDONED', endedAt: new Date() } });
    await prisma.deliveryTask.update({ where: { id: task.id }, data: { status: 'OPEN', riderId: null } });
    await prisma.order.update({ where: { id: orderId }, data: { status: 'READY_FOR_RIDER' } });
    expect((await history(riderUserId)).statusCode).toBe(403);
    expect((await read(riderUserId)).json()).not.toHaveProperty('preparationEstimate');
    expect((await app.inject({ method: 'GET', url: '/delivery-tasks/mine', headers: headers(riderUserId) })).json().find((t: { orderId: string }) => t.orderId === orderId)).not.toHaveProperty('preparationEstimate');
  });

  it('never updates predictions after handoff, including a disputed CLAIMED correction retaining its timestamp', async () => {
    await confirm();
    const task = await prisma.deliveryTask.findUniqueOrThrow({ where: { orderId } });
    const claim = await app.inject({ method: 'POST', url: `/delivery-tasks/${task.id}/claim`, headers: headers(riderUserId) });
    expect(claim.statusCode, claim.body).toBe(200);
    const assignment = await prisma.deliveryAssignment.findFirstOrThrow({ where: { orderId, status: 'ACTIVE' } });
    await confirmRiderPickup(prisma, { id: ownerId, role: 'MERCHANT', merchantId }, orderId,
      { assignmentId: assignment.id, expectedRevision: 0, requestKey: randomUUID() });
    expect((await write('2030-01-01T04:00:00Z')).statusCode).toBe(409);
    // A correction can restore CLAIMED while preserving a prior handoff timestamp.
    await prisma.order.update({ where: { id: orderId }, data: { status: 'CLAIMED' } });
    expect((await write('2030-01-01T04:00:00Z')).statusCode).toBe(409);
    expect((await history()).json()).toEqual([]);
  });

  it('checks the actual owner in service calls and prevents SQL overwriting appended history', async () => {
    await confirm();
    const input = { estimatedReadyAt: '2030-01-01T04:00:00Z', expectedVersion: 0, requestKey: randomUUID() };
    await expect(updatePreparationEstimate(prisma, { id: seedIds.merchantUser, role: 'MERCHANT', merchantId }, orderId, input, config.campusTimeZone)).rejects.toMatchObject({ statusCode: 403 });
    expect((await write(input.estimatedReadyAt)).statusCode).toBe(200);
    const audit = await prisma.merchantPreparationEstimateAudit.findFirstOrThrow({ where: { orderId } });
    await expect(prisma.merchantPreparationEstimateAudit.update({ where: { id: audit.id }, data: { estimatedReadyAt: new Date('2031-01-01') } })).rejects.toThrow();
    expect((await history()).json()[0].estimatedReadyAt).toBe('2030-01-01T04:00:00.000Z');
  });

  it('rejects an estimate queued behind a committed handoff under a real PostgreSQL row lock', async () => {
    await confirm();
    const locked = signal();
    const release = signal();
    const handingOff = prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "Order" WHERE "id"=${orderId}::uuid FOR UPDATE`;
      await tx.order.update({ where: { id: orderId }, data: { status: 'PICKED_UP' } });
      await tx.deliveryTask.update({ where: { orderId }, data: { status: 'PICKED_UP', pickedUpAt: new Date() } });
      locked.release();
      await release.promise;
    });
    await locked.promise;
    const updating = write('2030-01-01T04:00:00Z');
    try { await waitForOrderLock(); } finally { release.release(); }
    await handingOff;
    expect((await updating).statusCode).toBe(409);
    expect((await history()).json()).toEqual([]);
  });

  it('does not write a READY declaration after a handoff committed while the request waited', async () => {
    await confirm();
    const locked = signal();
    const release = signal();
    const handingOff = prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "Order" WHERE "id"=${orderId}::uuid FOR UPDATE`;
      await tx.order.update({ where: { id: orderId }, data: { status: 'PICKED_UP' } });
      await tx.deliveryTask.update({ where: { orderId }, data: { status: 'PICKED_UP', pickedUpAt: new Date() } });
      locked.release();
      await release.promise;
    });
    await locked.promise;
    const ready = app.inject({ method: 'POST', url: `/merchant/orders/${orderId}/ready`, headers: headers(ownerId) });
    try { await waitForOrderLock(); } finally { release.release(); }
    await handingOff;
    expect((await ready).statusCode).toBe(409);
    expect((await read()).json().merchantPreparationStatus).toBe('PREPARING');
    expect(await prisma.orderEvent.count({ where: { orderId, eventType: 'MERCHANT_PREPARATION_UPDATED' } })).toBe(0);
  });

  it('uses the configured campus time zone in the claim response as well as GET views', async () => {
    await confirm();
    await write('2030-01-01T04:00:00Z');
    const task = await prisma.deliveryTask.findUniqueOrThrow({ where: { orderId } });
    const otherCampus = await buildApp({ ...config, campusTimeZone: 'America/New_York' }, prisma);
    try {
      const pool = await otherCampus.inject({ method: 'GET', url: '/delivery-tasks/available', headers: headers(riderUserId) });
      expect(pool.json().find((t: { id: string }) => t.id === task.id).preparationEstimate).toMatchObject({ timeZone: 'America/New_York', estimatedReadyAtLocal: '2029-12-31 23:00:00' });
      const claim = await otherCampus.inject({ method: 'POST', url: `/delivery-tasks/${task.id}/claim`, headers: headers(riderUserId) });
      expect(claim.statusCode, claim.body).toBe(200);
      expect(claim.json().preparationEstimate).toMatchObject({ timeZone: 'America/New_York', estimatedReadyAtLocal: '2029-12-31 23:00:00' });
    } finally { await otherCampus.close(); }
  });
});
