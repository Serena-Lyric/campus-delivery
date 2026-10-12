import { DeliveryMethod, MerchantExposureState, PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { seedDatabase, seedIds } from '../../prisma/seed.js';
import { getMerchantBaseQuote } from '../../src/pricing/merchant-quote.js';
import { createOrder } from '../../src/orders/service.js';
import { checkoutQuantities, readCheckoutFacts } from '../../src/orders/quote.js';

function barrier() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

async function waitForDatabaseLock(table: string) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const rows = await prisma.$queryRaw<Array<{ waiting: boolean }>>`
      SELECT EXISTS(SELECT 1 FROM pg_stat_activity
        WHERE datname = current_database() AND wait_event_type = 'Lock'
          AND query LIKE ${`%"${table}"%`}) AS waiting`;
    if (rows[0]?.waiting) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`No observed PostgreSQL lock wait on ${table}`);
}

const prisma = new PrismaClient();
const headers = (id: string) => ({ 'x-user-id': id });
const config = { databaseUrl: process.env.DATABASE_URL!, host: '127.0.0.1', port: 3000,
  enableDevAuth: true, enableBackgroundJobs: false, backgroundSweepIntervalMs: 5000,
  campusTimeZone: 'Asia/Shanghai', logLevel: 'silent' as const };

describe('owner manual operations preserve catalog and existing contracts', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let ownerId: string;
  let merchantId: string;
  let productId: string;

  async function cleanFixtures() {
    const fixtures = await prisma.merchant.findMany({ where: { name: 'manual stall' }, select: { id: true, ownerId: true } });
    const ids = fixtures.map((m) => m.id);
    await prisma.order.deleteMany({ where: { merchantId: { in: ids } } });
    await prisma.merchantOperatingStatusAudit.deleteMany({ where: { merchantId: { in: ids } } });
    await prisma.merchant.deleteMany({ where: { id: { in: ids } } });
    await prisma.user.deleteMany({ where: { id: { in: fixtures.map((m) => m.ownerId) } } });
    await prisma.user.deleteMany({ where: { role: 'MERCHANT', displayName: 'unattached', merchant: null } });
  }

  beforeAll(async () => {
    await seedDatabase(prisma);
    await cleanFixtures();
    app = await buildApp(config, prisma);
    await app.ready();
  });
  beforeEach(async () => {
    const owner = await prisma.user.create({ data: { role: 'MERCHANT', displayName: 'operating owner' } });
    ownerId = owner.id;
    const merchant = await prisma.merchant.create({ data: { ownerId, name: 'manual stall',
      campusLocationId: seedIds.merchantLocation, exposureState: 'NORMAL',
      categories: { create: { name: 'menu' } } }, include: { categories: true } });
    merchantId = merchant.id;
    // Product needs the merchant's generated id independently of the display group.
    productId = (await prisma.product.create({ data: { merchantId, categoryId: merchant.categories[0]!.id,
      name: 'cake', priceMinor: 6000, deliveryCategoryCode: 'CAKE' } })).id;
  });
  afterAll(async () => { await app.close(); await cleanFixtures(); await prisma.$disconnect(); });

  const read = (user = ownerId) => app.inject({ method: 'GET', url: '/merchant/operating-status', headers: headers(user) });
  const change = (isOpen: boolean, expectedVersion: number, user = ownerId, extra = {}) => app.inject({
    method: 'PUT', url: '/merchant/operating-status', headers: headers(user),
    payload: { isOpen, expectedVersion, reason: 'manual operation', ...extra },
  });
  const input = () => ({ merchantId, destinationLocationId: seedIds.dormLocation,
    deliveryMethod: DeliveryMethod.DESIGNATED_POINT, items: [{ productId, quantity: 1 }] });
  const preview = () => app.inject({ method: 'POST', url: '/orders/price-preview', headers: headers(seedIds.customer), payload: input() });
  const order = (extra = {}) => app.inject({ method: 'POST', url: '/orders', headers: headers(seedIds.customer), payload: { ...input(), ...extra } });

  it('restricts reads and changes to the authenticated owner and rejects injected resource fields', async () => {
    expect((await read()).json()).toMatchObject({ id: merchantId, isOpen: true, operatingVersion: 0 });
    for (const user of [seedIds.customer, seedIds.riderAUser, seedIds.admin]) {
      expect((await read(user)).statusCode).toBe(403);
      expect((await change(false, 0, user)).statusCode).toBe(403);
    }
    const unattached = await prisma.user.create({ data: { role: 'MERCHANT', displayName: 'unattached' } });
    expect((await read(unattached.id)).statusCode).toBe(403);
    for (const extra of [{ merchantId: seedIds.merchant }, { ownerId: seedIds.merchantUser }, { exposureState: 'NORMAL' }, { inventory: 9 }]) {
      expect((await change(false, 0, ownerId, extra)).statusCode).toBe(400);
    }
    expect((await prisma.merchant.findUniqueOrThrow({ where: { id: merchantId } })).isOpen).toBe(true);
    expect((await change(false, (await read(seedIds.merchantUser)).json().operatingVersion, seedIds.merchantUser)).json().id).toBe(seedIds.merchant);
    expect((await prisma.merchant.findUniqueOrThrow({ where: { id: merchantId } })).isOpen).toBe(true);
    await change(true, (await read(seedIds.merchantUser)).json().operatingVersion, seedIds.merchantUser);
  });

  it('uses CAS for concurrent changes, rejects stale repeats and treats current no-op as unchanged', async () => {
    const results = await Promise.all([change(false, 0), change(false, 0)]);
    expect(results.map((r) => r.statusCode).sort()).toEqual([200, 409]);
    expect((await read()).json()).toMatchObject({ isOpen: false, operatingVersion: 1, operatingStatusLabel: '休息中', acceptingOrders: false });
    const noop = await change(false, 1);
    expect(noop.json()).toMatchObject({ changed: false, operatingVersion: 1 });
    const status = (await read()).json();
    expect(status.history).toHaveLength(1);
    expect(status.history[0]).toMatchObject({ previousIsOpen: true, newIsOpen: false, actorId: ownerId, reason: 'manual operation', version: 1 });
    expect(status.history[0].createdAt).toBeTruthy();
    expect((await change(true, 0)).statusCode).toBe(409);
  });

  it('keeps a resting menu visible but rejects preview and old quote creation, then restores purchasing', async () => {
    const quoted = await preview();
    expect(quoted.statusCode, quoted.body).toBe(200);
    expect((await change(false, 0)).statusCode).toBe(200);
    const listing = await app.inject({ method: 'GET', url: '/merchants', headers: headers(seedIds.customer) });
    expect(listing.json().find((m: { id: string }) => m.id === merchantId)).toMatchObject({ isOpen: false, acceptingOrders: false, operatingStatusLabel: '休息中' });
    const detail = await app.inject({ method: 'GET', url: `/merchants/${merchantId}/products`, headers: headers(seedIds.customer) });
    expect(detail.statusCode).toBe(200);
    expect(detail.json()).toMatchObject({ isOpen: false, acceptingOrders: false, operatingStatusLabel: '休息中' });
    expect(detail.json().categories[0].products[0].id).toBe(productId);
    expect((await preview()).statusCode).toBe(409);
    expect((await order({ expectedQuoteToken: quoted.json().quoteToken })).statusCode).toBe(409);
    expect((await change(true, 1)).statusCode).toBe(200);
    expect((await order()).statusCode).toBe(201);
    for (const privateField of ['ownerId', 'operatingVersion', 'exposureState', 'trialExposureOverrideBps', 'baseDeliveryPriceMinor', 'subsidy']) {
      expect(detail.body).not.toContain(privateField);
    }
  });

  it.each([MerchantExposureState.HIDDEN, MerchantExposureState.SUSPENDED])('never exposes a %s merchant by reopening or resting', async (exposureState) => {
    await prisma.merchant.update({ where: { id: merchantId }, data: { exposureState } });
    for (const [isOpen, version] of [[false, 0], [true, 1]] as const) {
      expect((await change(isOpen, version)).json()).toMatchObject({ acceptingOrders: false });
      expect((await app.inject({ method: 'GET', url: `/merchants/${merchantId}/products`, headers: headers(seedIds.customer) })).statusCode).toBe(404);
      const listing = await app.inject({ method: 'GET', url: '/merchants', headers: headers(seedIds.customer) });
      expect(listing.json().some((m: { id: string }) => m.id === merchantId)).toBe(false);
      expect((await preview()).statusCode).toBe(409);
    }
    expect((await prisma.merchant.findUniqueOrThrow({ where: { id: merchantId } })).exposureState).toBe(exposureState);
  });

  it('does not rewrite an existing order, price, item, delivery or funds when closing', async () => {
    const created = await order();
    expect(created.statusCode, created.body).toBe(201);
    const id = created.json().id;
    const full = () => prisma.order.findUniqueOrThrow({ where: { id }, include: { items: true, pricing: true, events: true, deliveryTask: true, settlement: true, riderSettlement: true, exceptions: true } });
    const before = await full();
    const quoteBefore = await getMerchantBaseQuote(prisma, { id: ownerId, role: 'MERCHANT', merchantId });
    expect((await change(false, 0)).statusCode).toBe(200);
    expect(await full()).toEqual(before);
    expect(await getMerchantBaseQuote(prisma, { id: ownerId, role: 'MERCHANT', merchantId })).toEqual(quoteBefore);
    expect(await prisma.merchantExposureDecision.count({ where: { merchantId } })).toBe(0);
  });

  it('does not silently reopen a seeded merchant or change the operating version on repeat seed', async () => {
    const before = (await read(seedIds.merchantUser)).json();
    expect((await change(false, before.operatingVersion, seedIds.merchantUser)).statusCode).toBe(200);
    const closed = (await read(seedIds.merchantUser)).json();
    await seedDatabase(prisma);
    await seedDatabase(prisma);
    expect((await read(seedIds.merchantUser)).json()).toEqual(closed);
    await change(true, closed.operatingVersion, seedIds.merchantUser);
  });

  it('serializes close-before-checkout: readers wait for the merchant write and then reject', async () => {
    const held = barrier();
    const release = barrier();
    const closing = prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "Merchant" WHERE "id" = ${merchantId}::uuid FOR UPDATE`;
      await tx.merchant.update({ where: { id: merchantId }, data: { isOpen: false } });
      held.release();
      await release.promise;
    });
    await held.promise;
    const quoting = preview();
    const creating = order();
    try { await waitForDatabaseLock('Merchant'); } finally { release.release(); }
    await closing;
    expect((await quoting).statusCode).toBe(409);
    expect((await creating).statusCode).toBe(409);
    expect(await prisma.order.count({ where: { merchantId } })).toBe(0);
  });

  it('serializes checkout-before-close: the writer waits and the created contract survives', async () => {
    const inserted = barrier();
    const release = barrier();
    const gated = prisma.$extends({ query: { order: { async create({ args, query }) {
      const result = await query(args);
      inserted.release();
      await release.promise;
      return result;
    } } } });
    const creating = createOrder(gated as unknown as PrismaClient, { id: seedIds.customer, role: 'CUSTOMER' }, input(), config.campusTimeZone);
    await inserted.promise;
    const closing = change(false, 0);
    try { await waitForDatabaseLock('Merchant'); } finally { release.release(); }
    const created = await creating;
    const before = await prisma.order.findUniqueOrThrow({ where: { id: created.id }, include: { pricing: true, items: true } });
    expect((await closing).statusCode).toBe(200);
    expect(await prisma.order.findUniqueOrThrow({ where: { id: created.id }, include: { pricing: true, items: true } })).toEqual(before);
    expect((await order()).statusCode).toBe(409);
  });

  it('holds the same merchant protection for a price preview', async () => {
    const held = barrier();
    const release = barrier();
    const previewing = prisma.$transaction(async (tx) => {
      const facts = await readCheckoutFacts(tx, input(), checkoutQuantities(input()));
      held.release();
      await release.promise;
      return facts.merchant.isOpen;
    });
    await held.promise;
    const closing = change(false, 0);
    try { await waitForDatabaseLock('Merchant'); } finally { release.release(); }
    expect(await previewing).toBe(true);
    expect((await closing).statusCode).toBe(200);
    expect((await preview()).statusCode).toBe(409);
  });
});
