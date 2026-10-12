import { DeliveryMethod, MerchantExposureState, PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { seedDatabase, seedIds } from '../../prisma/seed.js';
import { getMerchantBaseQuote } from '../../src/pricing/merchant-quote.js';
import { createOrder } from '../../src/orders/service.js';
import { checkoutQuantities, readCheckoutFacts } from '../../src/orders/quote.js';
import { releaseExpiredCoolingOrders } from '../../src/orders/lifecycle.js';
import { updateOperatingStatus } from '../../src/catalog/operating-status.js';
import { updateProductSaleStatus } from '../../src/catalog/product-status.js';
import { updateDailyRestorePreference } from '../../src/catalog/daily-restore-preference.js';
import { restoreDailyProducts } from '../../src/catalog/daily-restore.js';

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
    await prisma.deliveryTask.deleteMany({ where: { order: { merchantId: { in: ids } } } });
    await prisma.order.deleteMany({ where: { merchantId: { in: ids } } });
    await prisma.merchantOperatingStatusAudit.deleteMany({ where: { merchantId: { in: ids } } });
    await prisma.productSaleStatusAudit.deleteMany({ where: { merchantId: { in: ids } } });
    await prisma.productDailyRestoreAudit.deleteMany({ where: { run: { merchantId: { in: ids } } } });
    await prisma.merchantDailyRestoreRun.deleteMany({ where: { merchantId: { in: ids } } });
    await prisma.merchantDailyRestorePreferenceAudit.deleteMany({ where: { merchantId: { in: ids } } });
    await prisma.merchant.deleteMany({ where: { id: { in: ids } } });
    await prisma.user.deleteMany({ where: { id: { in: fixtures.map((m) => m.ownerId) } } });
    const riders = await prisma.rider.findMany({ where: { user: { displayName: 'manual lifecycle rider' } }, select: { id: true, userId: true } });
    await prisma.riderCapacityEvent.deleteMany({ where: { riderId: { in: riders.map((r) => r.id) } } });
    await prisma.rider.deleteMany({ where: { id: { in: riders.map((r) => r.id) } } });
    await prisma.user.deleteMany({ where: { id: { in: riders.map((r) => r.userId) } } });
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
  const sale = (saleStatus: string, expectedVersion: number, user = ownerId, id = productId, extra = {}) => app.inject({
    method: 'PUT', url: `/merchant/catalog/products/${id}/sale-status`, headers: headers(user),
    payload: { saleStatus, expectedVersion, reason: 'manual sales', ...extra },
  });
  const menu = () => app.inject({ method: 'GET', url: `/merchants/${merchantId}/products`, headers: headers(seedIds.customer) });
  const ownCatalog = () => app.inject({ method: 'GET', url: '/merchant/catalog', headers: headers(ownerId) });

  it('displays sold-out items without selling them, hides off-shelf items, and restores on-sale explicitly', async () => {
    const before = await preview();
    expect(before.statusCode).toBe(200);
    expect((await menu()).json().categories[0].products[0]).toMatchObject({ saleStatus: 'ON_SALE', purchasable: true });
    expect((await sale('SOLD_OUT', 1)).statusCode).toBe(200);
    expect((await menu()).json().categories[0].products[0]).toMatchObject({ id: productId, isAvailable: false, saleStatus: 'SOLD_OUT', saleStatusLabel: '已售罄', purchasable: false });
    expect((await preview()).statusCode).toBe(400);
    expect((await order({ expectedQuoteToken: before.json().quoteToken })).statusCode).toBe(400);
    expect((await change(false, 0)).statusCode).toBe(200);
    expect((await menu()).json().categories[0].products[0]).toMatchObject({ saleStatus: 'SOLD_OUT', purchasable: false });
    expect((await sale('ON_SALE', 2)).statusCode).toBe(200);
    expect((await menu()).json().categories[0].products[0]).toMatchObject({ saleStatus: 'ON_SALE', purchasable: false });
    expect((await change(true, 1)).statusCode).toBe(200);
    expect((await menu()).json().categories[0].products[0]).toMatchObject({ saleStatus: 'ON_SALE', purchasable: true });
    expect((await order({ expectedQuoteToken: before.json().quoteToken })).statusCode).toBe(409);
    expect((await order()).statusCode).toBe(201);
    expect((await sale('OFF_SHELF', 3)).statusCode).toBe(200);
    expect((await menu()).json().categories[0].products).toEqual([]);
    expect((await ownCatalog()).json()[0].products[0]).toMatchObject({ saleStatus: 'OFF_SHELF', isAvailable: false });
    expect((await preview()).statusCode).toBe(400);
    expect((await order()).statusCode).toBe(400);
  });

  it('isolates quick sales changes, audits once and preserves every product fact except sale/version/time', async () => {
    const before = await prisma.product.findUniqueOrThrow({ where: { id: productId } });
    for (const user of [seedIds.customer, seedIds.riderAUser, seedIds.admin]) expect((await sale('SOLD_OUT', 1, user)).statusCode).toBe(403);
    expect((await sale('SOLD_OUT', 1, seedIds.merchantUser)).statusCode).toBe(409);
    for (const extra of [{ merchantId: seedIds.merchant }, { isAvailable: true }, { priceMinor: 1 }, { deliveryCategoryCode: 'ORDINARY_MEAL' }, { inventory: 9 }]) {
      expect((await sale('SOLD_OUT', 1, ownerId, productId, extra)).statusCode).toBe(400);
    }
    const results = await Promise.all([sale('SOLD_OUT', 1), sale('OFF_SHELF', 1)]);
    expect(results.map((r) => r.statusCode).sort()).toEqual([200, 409]);
    const current = (await ownCatalog()).json()[0].products[0];
    expect((await sale(current.saleStatus, 2)).json()).toMatchObject({ changed: false, version: 2 });
    expect((await sale('ON_SALE', 1)).statusCode).toBe(409);
    const after = await prisma.product.findUniqueOrThrow({ where: { id: productId } });
    const withoutSales = (p: object) => Object.fromEntries(Object.entries(p).filter(([key]) => !['saleStatus', 'isAvailable', 'version', 'updatedAt'].includes(key)));
    expect(withoutSales(after)).toEqual(withoutSales(before));
    const history = await prisma.$queryRaw<Array<{ actorId: string; previousStatus: string; newStatus: string; reason: string; version: number }>>`
      SELECT "actorId", "previousStatus", "newStatus", "reason", "version" FROM "ProductSaleStatusAudit" WHERE "productId"=${productId}::uuid`;
    expect(history).toEqual([{ actorId: ownerId, previousStatus: 'ON_SALE', newStatus: current.saleStatus, reason: 'manual sales', version: 2 }]);
  });

  it('retains legacy boolean create/edit behavior without restoring an unchanged sold-out flag', async () => {
    const product = await prisma.product.findUniqueOrThrow({ where: { id: productId } });
    const body = { categoryId: product.categoryId, name: product.name, priceMinor: 6000,
      isAvailable: false, deliveryCategoryCode: 'CAKE', sortOrder: 0, marketingTags: [] };
    const hidden = await app.inject({ method: 'POST', url: '/merchant/catalog/products', headers: headers(ownerId), payload: body });
    expect(hidden.statusCode).toBe(201);
    expect(hidden.json()).toMatchObject({ saleStatus: 'OFF_SHELF', isAvailable: false });
    expect((await menu()).json().categories[0].products.map((p: { id: string }) => p.id)).not.toContain(hidden.json().id);
    expect((await sale('SOLD_OUT', 1)).statusCode).toBe(200);
    const edited = await app.inject({ method: 'PUT', url: `/merchant/catalog/products/${productId}`, headers: headers(ownerId), payload: { ...body, name: 'new display name', expectedVersion: 2 } });
    expect(edited.statusCode, edited.body).toBe(200);
    expect(edited.json()).toMatchObject({ saleStatus: 'SOLD_OUT', isAvailable: false, version: 3 });
    const restored = await app.inject({ method: 'PUT', url: `/merchant/catalog/products/${productId}`, headers: headers(ownerId), payload: { ...body, isAvailable: true, expectedVersion: 3 } });
    expect(restored.json()).toMatchObject({ saleStatus: 'ON_SALE', isAvailable: true, version: 4 });
    const off = await app.inject({ method: 'PUT', url: `/merchant/catalog/products/${productId}`, headers: headers(ownerId), payload: { ...body, expectedVersion: 4 } });
    expect(off.json()).toMatchObject({ saleStatus: 'OFF_SHELF', isAvailable: false, version: 5 });
  });

  it('rejects extra full-editor fields before validation can silently strip them', async () => {
    const product = await prisma.product.findUniqueOrThrow({ where: { id: productId } });
    const body = { categoryId: product.categoryId, name: product.name, priceMinor: 6000,
      isAvailable: true, deliveryCategoryCode: 'CAKE', sortOrder: 0, marketingTags: [] };
    for (const extra of [{ merchantId: seedIds.merchant }, { coreFragile: false }, { saleStatus: 'SOLD_OUT' }]) {
      expect((await app.inject({ method: 'POST', url: '/merchant/catalog/products', headers: headers(ownerId), payload: { ...body, ...extra } })).statusCode).toBe(400);
      expect((await app.inject({ method: 'PUT', url: `/merchant/catalog/products/${productId}`, headers: headers(ownerId), payload: { ...body, expectedVersion: 1, ...extra } })).statusCode).toBe(400);
    }
    expect(await prisma.product.findUniqueOrThrow({ where: { id: productId } })).toEqual(product);
  });

  it('does not restore seeded sold-out or off-shelf products on repeated seed', async () => {
    const catalog = await app.inject({ method: 'GET', url: '/merchant/catalog', headers: headers(seedIds.merchantUser) });
    const products = catalog.json().flatMap((c: { products: Array<{ id: string; version: number }> }) => c.products);
    const rice = products.find((p: { id: string }) => p.id === seedIds.productRice);
    const tea = products.find((p: { id: string }) => p.id === seedIds.productTea);
    expect((await sale('SOLD_OUT', rice.version, seedIds.merchantUser, rice.id)).statusCode).toBe(200);
    expect((await sale('OFF_SHELF', tea.version, seedIds.merchantUser, tea.id)).statusCode).toBe(200);
    const before = await app.inject({ method: 'GET', url: '/merchant/catalog', headers: headers(seedIds.merchantUser) });
    await seedDatabase(prisma);
    await seedDatabase(prisma);
    expect((await app.inject({ method: 'GET', url: '/merchant/catalog', headers: headers(seedIds.merchantUser) })).json()).toEqual(before.json());
    await sale('ON_SALE', rice.version + 1, seedIds.merchantUser, rice.id);
    await sale('ON_SALE', tea.version + 1, seedIds.merchantUser, tea.id);
  });

  it('serializes sold-out-before-checkout against preview and creation on the product row', async () => {
    const held = barrier();
    const release = barrier();
    const stopping = prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "Product" WHERE "id"=${productId}::uuid FOR UPDATE`;
      await tx.product.update({ where: { id: productId }, data: { saleStatus: 'SOLD_OUT', version: { increment: 1 } } });
      held.release();
      await release.promise;
    });
    await held.promise;
    const quoting = preview();
    const creating = order();
    try { await waitForDatabaseLock('Product'); } finally { release.release(); }
    await stopping;
    expect((await quoting).statusCode).toBe(400);
    expect((await creating).statusCode).toBe(400);
    expect(await prisma.order.count({ where: { merchantId } })).toBe(0);
  });

  it('serializes checkout-before-sold-out and preserves the created price and mandatory core risk', async () => {
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
    const stopping = sale('SOLD_OUT', 1);
    try { await waitForDatabaseLock('Product'); } finally { release.release(); }
    const created = await creating;
    expect((await stopping).statusCode).toBe(200);
    const persisted = await prisma.order.findUniqueOrThrow({ where: { id: created.id }, include: { pricing: true, items: true } });
    expect(persisted).toMatchObject({ status: 'CREATED', coreFragileValueMinor: 6000, pickupEvidenceLevel: 'REQUIRED' });
    expect(persisted.items[0]).toMatchObject({ productNameSnapshot: 'cake', unitPriceMinor: 6000, coreFragileSnapshot: true, deliveryCategoryCodeSnapshot: 'CAKE' });
    expect(persisted.pricing).toEqual(created.pricing);
    expect((await order()).statusCode).toBe(400);
  });

  it('holds product protection during preview and invalidates that quote after a waiting sold-out change', async () => {
    const held = barrier();
    const release = barrier();
    const previewing = prisma.$transaction(async (tx) => {
      const facts = await readCheckoutFacts(tx, input(), checkoutQuantities(input()));
      held.release();
      await release.promise;
      return facts.products[0]!.saleStatus;
    });
    const token = (await preview()).json().quoteToken;
    await held.promise;
    const stopping = sale('SOLD_OUT', 1);
    try { await waitForDatabaseLock('Product'); } finally { release.release(); }
    expect(await previewing).toBe('ON_SALE');
    expect((await stopping).statusCode).toBe(200);
    expect((await order({ expectedQuoteToken: token })).statusCode).toBe(400);
  });

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

  it('rechecks OWNER in services even when supplied a forged merchant binding', async () => {
    const actor = { id: ownerId, role: 'MERCHANT' as const, merchantId: seedIds.merchant };
    await expect(updateOperatingStatus(prisma, actor, { isOpen: false, expectedVersion: 0, reason: 'forged owner' })).rejects.toMatchObject({ statusCode: 404 });
    await expect(updateProductSaleStatus(prisma, actor, seedIds.productRice, { saleStatus: 'SOLD_OUT', expectedVersion: 1, reason: 'forged owner' })).rejects.toMatchObject({ statusCode: 404 });
  });

  it('keeps legacy ORM boolean writes consistent and never exposes a hidden product', async () => {
    await prisma.product.update({ where: { id: productId }, data: { isAvailable: false } });
    expect((await ownCatalog()).json()[0].products[0]).toMatchObject({ isAvailable: false, saleStatus: 'OFF_SHELF' });
    expect((await menu()).json().categories[0].products).toEqual([]);
    expect((await order()).statusCode).toBe(400);
    await prisma.product.update({ where: { id: productId }, data: { isAvailable: true } });
    expect((await menu()).json().categories[0].products[0]).toMatchObject({ isAvailable: true, saleStatus: 'ON_SALE', purchasable: true });
    await sale('SOLD_OUT', 1);
    await prisma.product.update({ where: { id: productId }, data: { isAvailable: false, name: 'legacy display edit' } });
    expect((await menu()).json().categories[0].products[0]).toMatchObject({ saleStatus: 'SOLD_OUT', purchasable: false });
  });

  it('preserves confirmed, claimed and finalized facts across daily recovery and completes mandatory photo fulfillment while closed/off-shelf', async () => {
    const rider = await prisma.rider.create({ data: { status: 'AVAILABLE', capacityOverride: 10,
      firstNormalDeliveredAt: new Date('2026-09-20T04:00:00Z'), user: { create: { role: 'RIDER', displayName: 'manual lifecycle rider' } } } });
    const created = await order();
    expect(created.statusCode, created.body).toBe(201);
    const orderId = created.json().id as string;
    expect((await change(false, 0)).statusCode).toBe(200);
    expect((await sale('SOLD_OUT', 1)).statusCode).toBe(200);
    await prisma.order.update({ where: { id: orderId }, data: { coolingOffEndsAt: new Date(Date.now() - 1000) } });
    await releaseExpiredCoolingOrders(prisma);
    const confirmed = await app.inject({ method: 'POST', url: `/merchant/orders/${orderId}/confirm`, headers: headers(ownerId) });
    expect(confirmed.statusCode, confirmed.body).toBe(200);
    const taskId = confirmed.json().deliveryTask.id as string;
    const full = () => prisma.order.findUniqueOrThrow({ where: { id: orderId }, include: { items: true, pricing: true,
      events: { orderBy: { id: 'asc' } }, deliveryTask: true, assignments: true, settlement: true, riderSettlement: true } });
    const confirmedBefore = await full();
    await updateDailyRestorePreference(prisma, { id: ownerId, role: 'MERCHANT', merchantId },
      { enabled: true, expectedVersion: 0, reason: 'opt into daily recovery' }, config.campusTimeZone);
    const auto = (instant: string) => restoreDailyProducts(prisma, { ...config, enableBackgroundJobs: true }, () => new Date(instant));
    expect(await auto('2026-10-11T20:00:00Z')).toBe(1);
    expect(await full()).toEqual(confirmedBefore);
    expect((await sale('OFF_SHELF', 3)).statusCode).toBe(200);
    expect((await change(true, 1)).statusCode).toBe(200);
    expect(await full()).toEqual(confirmedBefore);
    const claimed = await app.inject({ method: 'POST', url: `/delivery-tasks/${taskId}/claim`, headers: headers(rider.userId) });
    expect(claimed.statusCode, claimed.body).toBe(200);
    const claimedBefore = await full();
    expect((await change(false, 2)).statusCode).toBe(200);
    expect((await sale('SOLD_OUT', 4)).statusCode).toBe(200);
    expect(await auto('2026-10-12T20:00:00Z')).toBe(1);
    expect(await full()).toEqual(claimedBefore);
    const assignment = claimedBefore.assignments.find((a) => a.status === 'ACTIVE')!;
    const pickup = (photoEvidenceId?: string) => app.inject({ method: 'POST', url: `/merchant/orders/${orderId}/confirm-rider-pickup`,
      headers: headers(ownerId), payload: { assignmentId: assignment.id, expectedRevision: claimedBefore.pickupHandoffRevision,
        requestKey: randomUUID(), ...(photoEvidenceId ? { photoEvidenceId } : {}) } });
    expect((await pickup()).statusCode).toBe(409);
    const photo = await app.inject({ method: 'POST', url: `/orders/${orderId}/evidence`, headers: headers(rider.userId),
      payload: { evidenceType: 'RIDER_PICKUP_PHOTO', media: { fileName: 'pickup.jpg', contentType: 'image/jpeg', source: 'CAMERA' } } });
    expect(photo.statusCode, photo.body).toBe(201);
    expect((await pickup(photo.json().id)).statusCode).toBe(200);
    const delivered = await app.inject({ method: 'POST', url: `/delivery-tasks/${taskId}/deliver`, headers: headers(rider.userId), payload: {} });
    expect(delivered.statusCode, delivered.body).toBe(200);
    const finalizedBefore = await full();
    expect(finalizedBefore).toMatchObject({ status: 'DELIVERED', settlement: { status: 'FINALIZED' }, riderSettlement: { amountMinor: 200 } });
    expect((await sale('OFF_SHELF', 6)).statusCode).toBe(200);
    expect((await change(true, 3)).statusCode).toBe(200);
    expect(await full()).toEqual(finalizedBefore);
    expect((await sale('SOLD_OUT', 7)).statusCode).toBe(200);
    expect(await auto('2026-10-13T20:00:00Z')).toBe(1);
    expect(await full()).toEqual(finalizedBefore);
    for (const user of [seedIds.customer, ownerId, rider.userId]) {
      const view = await app.inject({ method: 'GET', url: `/orders/${orderId}`, headers: headers(user) });
      expect(view.statusCode).toBe(200);
      expect(view.body).not.toContain('saleStatus');
      expect(view.body).not.toContain('operatingVersion');
      for (const field of ['dailyProductRestore', 'dailyRestore', 'preferenceVersion', 'configVersion', 'AUTO_DAILY']) expect(view.body).not.toContain(field);
      for (const field of ['ownerId', 'platformSubsidyMinor', 'deliveryPricingPolicySnapshot']) expect(view.body).not.toContain(field);
      if (user !== ownerId) expect(view.body).not.toContain('merchantRescueContributionMinor');
    }
  });
});
