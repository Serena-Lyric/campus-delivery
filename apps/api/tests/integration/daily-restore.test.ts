import { DeliveryMethod, PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { seedDatabase, seedIds } from '../../prisma/seed.js';
import * as background from '../../src/background.js';
import { getDailyRestorePreference, updateDailyRestorePreference } from '../../src/catalog/daily-restore-preference.js';
import { updateBusinessConfig } from '../../src/admin/config-service.js';
import { createOrder } from '../../src/orders/service.js';
import { checkoutQuantities, readCheckoutFacts } from '../../src/orders/quote.js';

function barrier() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}
async function waitForLock(pattern: string) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const [row] = await prisma.$queryRaw<Array<{ waiting: boolean }>>`SELECT EXISTS(SELECT 1 FROM pg_stat_activity
      WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE ${`%${pattern}%`}) AS waiting`;
    if (row?.waiting) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`No observed PostgreSQL lock wait: ${pattern}`);
}

const prisma = new PrismaClient();
const config = { databaseUrl: process.env.DATABASE_URL!, host: '127.0.0.1', port: 3000,
  enableDevAuth: true, enableBackgroundJobs: false, backgroundSweepIntervalMs: 5000,
  campusTimeZone: 'Asia/Shanghai', logLevel: 'silent' as const };
const key = 'PRODUCT_DAILY_RESTORE';
const headers = (id: string) => ({ 'x-user-id': id });
describe('daily restore opt-in and schedule', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let ownerId: string;
  let merchantId: string;
  let soldId: string;
  let hiddenId: string;
  let onSaleId: string;
  async function cleanFixtures() {
    await prisma.deliveryTask.deleteMany({ where: { order: { merchant: { name: 'daily stall' } } } });
    await prisma.order.deleteMany({ where: { merchant: { name: 'daily stall' } } });
    await prisma.productSaleStatusAudit.deleteMany({ where: { merchant: { name: 'daily stall' } } });
    const tables = await prisma.$queryRaw<Array<{ name: string }>>`SELECT tablename AS name FROM pg_tables WHERE schemaname='public'`;
    for (const table of ['ProductDailyRestoreAudit', 'MerchantDailyRestoreRun', 'MerchantDailyRestorePreferenceAudit']) {
      if (tables.some((t) => t.name === table)) await prisma.$executeRawUnsafe(`DELETE FROM "${table}"`);
    }
    await prisma.merchant.deleteMany({ where: { name: 'daily stall' } });
    await prisma.user.deleteMany({ where: { displayName: 'daily owner' } });
    await prisma.businessConfigAudit.deleteMany({ where: { key } });
    await prisma.businessConfig.deleteMany({ where: { key } });
    await prisma.merchant.update({ where: { id: seedIds.merchant }, data: { dailyProductRestoreEnabled: false, dailyProductRestoreVersion: 0 } });
  }
  beforeAll(async () => { await seedDatabase(prisma); await cleanFixtures(); app = await buildApp(config, prisma); await app.ready(); });
  beforeEach(async () => {
    await cleanFixtures();
    ownerId = (await prisma.user.create({ data: { role: 'MERCHANT', displayName: 'daily owner' } })).id;
    merchantId = (await prisma.merchant.create({ data: { ownerId, name: 'daily stall', exposureState: 'NORMAL', campusLocationId: seedIds.merchantLocation } })).id;
    const category = await prisma.productCategory.create({ data: { merchantId, name: 'menu' } });
    for (const saleStatus of ['SOLD_OUT', 'OFF_SHELF', 'ON_SALE'] as const) {
      const p = await prisma.product.create({ data: { merchantId, categoryId: category.id, name: saleStatus, saleStatus, deliveryCategoryCode: 'CAKE', priceMinor: 6000 } });
      if (saleStatus === 'SOLD_OUT') soldId = p.id;
      else if (saleStatus === 'OFF_SHELF') hiddenId = p.id;
      else onSaleId = p.id;
    }
  });
  afterAll(async () => {
    await cleanFixtures();
    await app?.close(); await prisma.$disconnect();
  });
  const read = (id = ownerId) => app.inject({ method: 'GET', url: '/merchant/daily-product-restore', headers: headers(id) });
  const toggle = (enabled: boolean, expectedVersion = 0, id = ownerId, extra = {}) => app.inject({ method: 'PUT',
    url: '/merchant/daily-product-restore', headers: headers(id), payload: { enabled, expectedVersion, reason: 'opt in', ...extra } });
  const schedule = (payload: object, expectedVersion: number | undefined = 0, extra = {}, id: string = seedIds.admin) => app.inject({ method: 'PUT',
    url: `/admin/business-configs/${key}`, headers: headers(id), payload: { payload, reason: 'schedule', expectedVersion, ...extra } });
  const sweep = async (instant: string, enabled = true, timeZone = 'Asia/Shanghai') => {
    return background.restoreDailyProducts(prisma, { ...config, enableBackgroundJobs: enabled, campusTimeZone: timeZone }, () => new Date(instant));
  };
  const product = () => prisma.product.findUniqueOrThrow({ where: { id: soldId } });
  const input = (productId = onSaleId) => ({ merchantId, destinationLocationId: seedIds.dormLocation,
    deliveryMethod: DeliveryMethod.DESIGNATED_POINT, items: [{ productId, quantity: 1 }] });
  const preview = (productId = onSaleId) => app.inject({ method: 'POST', url: '/orders/price-preview', headers: headers(seedIds.customer), payload: input(productId) });
  const sale = (saleStatus: string, expectedVersion: number) => app.inject({ method: 'PUT', url: `/merchant/catalog/products/${soldId}/sale-status`,
    headers: headers(ownerId), payload: { saleStatus, expectedVersion, reason: 'manual after sweep' } });

  it('defaults off with an effective local 04:00 default rather than a fabricated admin version', async () => {
    const docs = app.swagger() as { paths: Record<string, { get: { responses: Record<string, { content?: Record<string, { schema: { properties: Record<string, unknown> } }> }> } }> };
    expect(docs.paths['/merchant/daily-product-restore']!.get.responses['200']!.content?.['application/json']?.schema.properties ?? {}).toHaveProperty('schedule');
    const before = await prisma.merchant.findUniqueOrThrow({ where: { id: merchantId } });
    expect((await read()).json()).toMatchObject({ enabled: false, version: 0, schedule: { time: '04:00', version: 0, source: 'SYSTEM_DEFAULT', timeZone: 'Asia/Shanghai' } });
    expect((await toggle(false)).json()).toMatchObject({ changed: false, version: 0 });
    const responses = await Promise.all([toggle(true), toggle(true)]);
    expect(responses.map((r) => r.statusCode).sort()).toEqual([200, 409]);
    expect((await toggle(true, 1)).json()).toMatchObject({ changed: false, version: 1 });
    expect((await toggle(false)).statusCode).toBe(409);
    expect((await read()).json().history).toHaveLength(1);
    const after = await prisma.merchant.findUniqueOrThrow({ where: { id: merchantId } });
    expect(after.isOpen).toBe(before.isOpen); expect(after.operatingVersion).toBe(before.operatingVersion);
  });
  it('rejects foreign bindings, roles and unrecognized preference fields', async () => {
    for (const id of [seedIds.customer, seedIds.riderAUser, seedIds.admin]) expect((await toggle(true, 0, id)).statusCode).toBe(403);
    for (const extra of [{ merchantId: seedIds.merchant }, { ownerId }, { isOpen: true }, { inventory: 2 }]) expect((await toggle(true, 0, ownerId, extra)).statusCode).toBe(400);
    const other = await prisma.user.create({ data: { role: 'MERCHANT', displayName: 'daily owner' } });
    const foreign = await prisma.merchant.create({ data: { ownerId: other.id, name: 'daily stall', campusLocationId: seedIds.merchantLocation,
      categories: { create: { name: 'menu' } } }, include: { categories: true } });
    const foreignProduct = await prisma.product.create({ data: { merchantId: foreign.id, categoryId: foreign.categories[0]!.id,
      name: 'foreign sold out', saleStatus: 'SOLD_OUT', priceMinor: 100, deliveryCategoryCode: 'ORDINARY_MEAL' } });
    expect((await toggle(true, 0, other.id)).statusCode).toBe(200);
    expect((await read()).json()).toMatchObject({ enabled: false, version: 0 });
    expect(await sweep('2026-10-11T20:00:00Z')).toBe(1);
    expect(await prisma.product.findUniqueOrThrow({ where: { id: foreignProduct.id } })).toMatchObject({ saleStatus: 'ON_SALE', version: 2 });
    expect(await product()).toMatchObject({ saleStatus: 'SOLD_OUT', version: 1 });
  });
  it('validates and serializes versioned ordinary admin schedule changes', async () => {
    expect((await schedule({ time: '06:15' }, 0, { expectedVersion: undefined })).statusCode).toBe(400);
    for (const payload of [{ time: '24:00' }, { time: '4:00' }, { time: '04:60' }, { time: '04:00', enabled: true }]) expect((await schedule(payload)).statusCode).toBe(400);
    expect((await schedule({ time: '06:15' }, 0, { merchantId })).statusCode).toBe(400);
    expect((await schedule({ time: '06:15' }, 0, {}, seedIds.operator)).statusCode).toBe(403);
    const results = await Promise.all([schedule({ time: '06:15' }), schedule({ time: '07:00' })]);
    expect(results.map((r) => r.statusCode).sort()).toEqual([200, 409]);
    const time = results.find((r) => r.statusCode === 200)!.json().payload.time;
    expect((await schedule({ time }, 1)).json()).toMatchObject({ version: 1 });
    expect(await prisma.businessConfigAudit.count({ where: { key } })).toBe(1);
    expect((await read()).json()).toMatchObject({ enabled: false, schedule: { time, version: 1, source: 'ADMIN_CONFIG' } });
  });

  it('requires opt-in, restores only temporary sales and never opens a resting stall or rewrites an order', async () => {
    const order = await app.inject({ method: 'POST', url: '/orders', headers: headers(seedIds.customer), payload: {
      merchantId, destinationLocationId: seedIds.dormLocation, deliveryMethod: DeliveryMethod.DESIGNATED_POINT, items: [{ productId: onSaleId, quantity: 1 }] } });
    expect(order.statusCode, order.body).toBe(201);
    const facts = await prisma.order.findUniqueOrThrow({ where: { id: order.json().id }, include: { items: true, pricing: true } });
    await prisma.merchant.update({ where: { id: merchantId }, data: { isOpen: false } });
    expect(await sweep('2026-10-11T20:00:00Z')).toBe(0);
    expect((await product()).saleStatus).toBe('SOLD_OUT');
    await toggle(true);
    const before = await product();
    expect(await sweep('2026-10-11T20:00:00Z')).toBeGreaterThan(0);
    const after = await product();
    expect(after).toMatchObject({ saleStatus: 'ON_SALE', isAvailable: true, version: 2 });
    const stable = (p: object) => Object.fromEntries(Object.entries(p).filter(([k]) => !['saleStatus', 'isAvailable', 'version', 'updatedAt'].includes(k)));
    expect(stable(after)).toEqual(stable(before));
    expect(await prisma.product.findUniqueOrThrow({ where: { id: hiddenId } })).toMatchObject({ saleStatus: 'OFF_SHELF', isAvailable: false, version: 1 });
    expect(await prisma.product.findUniqueOrThrow({ where: { id: onSaleId } })).toMatchObject({ saleStatus: 'ON_SALE', version: 1 });
    expect(await prisma.merchant.findUniqueOrThrow({ where: { id: merchantId } })).toMatchObject({ isOpen: false, operatingVersion: 0 });
    expect(await prisma.order.findUniqueOrThrow({ where: { id: facts.id }, include: { items: true, pricing: true } })).toEqual(facts);
    const menu = await app.inject({ method: 'GET', url: `/merchants/${merchantId}/products`, headers: headers(seedIds.customer) });
    expect(menu.json().categories[0].products.every((p: { purchasable: boolean }) => !p.purchasable)).toBe(true);
    const preview = await app.inject({ method: 'POST', url: '/orders/price-preview', headers: headers(seedIds.customer), payload: {
      merchantId, destinationLocationId: seedIds.dormLocation, deliveryMethod: DeliveryMethod.DESIGNATED_POINT, items: [{ productId: soldId, quantity: 1 }] } });
    expect(preview.statusCode).toBe(409);
  });

  it('uses local 04:00 boundaries and one durable run despite dual workers, manual resale and restart', async () => {
    await toggle(true);
    for (const instant of ['2026-10-11T16:00:00Z', '2026-10-11T19:59:59Z']) {
      await sweep(instant); expect((await product()).saleStatus).toBe('SOLD_OUT');
    }
    await Promise.all([sweep('2026-10-11T20:00:00Z'), sweep('2026-10-11T20:00:00Z')]);
    expect((await product()).version).toBe(2);
    expect((await sale('SOLD_OUT', 2)).statusCode).toBe(200);
    await sweep('2026-10-12T15:59:59Z');
    await toggle(false, 1); await toggle(true, 2);
    await schedule({ time: '00:00' });
    await sweep('2026-10-12T15:59:59Z');
    expect(await product()).toMatchObject({ saleStatus: 'SOLD_OUT', version: 3 });
    await sweep('2026-10-12T16:00:00Z');
    expect(await product()).toMatchObject({ saleStatus: 'ON_SALE', version: 4 });
    const runs = await prisma.$queryRaw<Array<{ day: Date; configVersion: number; scheduledTime: string; actorType: string; source: string; restoredCount: number }>>`
      SELECT "day", "configVersion", "scheduledTime", "actorType", "source", "restoredCount" FROM "MerchantDailyRestoreRun" WHERE "merchantId"=${merchantId}::uuid ORDER BY "day"`;
    expect(runs).toEqual([
      { day: new Date('2026-10-12T00:00:00Z'), configVersion: 0, scheduledTime: '04:00', actorType: 'SYSTEM', source: 'AUTO_DAILY', restoredCount: 1 },
      { day: new Date('2026-10-13T00:00:00Z'), configVersion: 1, scheduledTime: '00:00', actorType: 'SYSTEM', source: 'AUTO_DAILY', restoredCount: 1 },
    ]);
    const audits = await prisma.$queryRaw<Array<{ version: number; previousStatus: string; newStatus: string }>>`SELECT "version", "previousStatus", "newStatus" FROM "ProductDailyRestoreAudit" WHERE "productId"=${soldId}::uuid ORDER BY "version"`;
    expect(audits).toEqual([{ version: 2, previousStatus: 'SOLD_OUT', newStatus: 'ON_SALE' }, { version: 4, previousStatus: 'SOLD_OUT', newStatus: 'ON_SALE' }]);
  });

  it('catches up only the current day, supports late opt-in and changed time, and records zero-work days', async () => {
    await toggle(true); await schedule({ time: '07:30' });
    await sweep('2026-10-11T23:29:59Z'); expect((await product()).saleStatus).toBe('SOLD_OUT');
    await sweep('2026-10-11T23:30:00Z'); expect((await product()).saleStatus).toBe('ON_SALE');
    await sweep('2026-10-14T23:30:00Z');
    const rows = await prisma.$queryRaw<Array<{ day: Date; restoredCount: number }>>`SELECT "day", "restoredCount" FROM "MerchantDailyRestoreRun" WHERE "merchantId"=${merchantId}::uuid ORDER BY "day"`;
    expect(rows).toEqual([{ day: new Date('2026-10-12T00:00:00Z'), restoredCount: 1 }, { day: new Date('2026-10-15T00:00:00Z'), restoredCount: 0 }]);
    await sale('SOLD_OUT', 2);
    await sweep('2026-10-12T23:30:00Z');
    expect(await product()).toMatchObject({ saleStatus: 'SOLD_OUT', version: 3 });
    expect(await prisma.merchantDailyRestoreRun.count({ where: { merchantId } })).toBe(2);
  });

  it.each(['HIDDEN', 'SUSPENDED'] as const)('honors disabled jobs and a different local date without restoring %s visibility', async (exposureState) => {
    await toggle(true); await prisma.merchant.update({ where: { id: merchantId }, data: { exposureState } });
    await sweep('2026-10-12T20:00:00Z', false); expect((await product()).saleStatus).toBe('SOLD_OUT');
    await read(); expect((await product()).saleStatus).toBe('SOLD_OUT');
    await sweep('2026-10-12T03:59:59Z', true, 'UTC'); expect((await product()).saleStatus).toBe('SOLD_OUT');
    await sweep('2026-10-12T04:00:00Z', true, 'UTC'); expect((await product()).saleStatus).toBe('ON_SALE');
    const menu = await app.inject({ method: 'GET', url: `/merchants/${merchantId}/products`, headers: headers(seedIds.customer) });
    expect(menu.statusCode).toBe(404);
    expect(await prisma.merchant.findUniqueOrThrow({ where: { id: merchantId } })).toMatchObject({ exposureState });
  });

  it('rolls back the whole batch on an audit failure and safely retries after recovery', async () => {
    await toggle(true);
    await prisma.product.update({ where: { id: onSaleId }, data: { saleStatus: 'SOLD_OUT' } });
    // Failing the second event proves the first write/event/run are not committed early.
    const rejectedId = [soldId, onSaleId].sort()[1]!;
    await prisma.$executeRawUnsafe(`ALTER TABLE "ProductDailyRestoreAudit" ADD CONSTRAINT round8_test_failure CHECK ("productId" <> '${rejectedId}'::uuid)`);
    try {
      await expect(sweep('2026-10-11T20:00:00Z')).rejects.toThrow();
      expect(await prisma.merchantDailyRestoreRun.count({ where: { merchantId } })).toBe(0);
      expect(await prisma.productDailyRestoreAudit.count()).toBe(0);
      expect(await product()).toMatchObject({ saleStatus: 'SOLD_OUT', version: 1 });
      expect(await prisma.product.findUniqueOrThrow({ where: { id: onSaleId } })).toMatchObject({ saleStatus: 'SOLD_OUT', version: 1 });
    } finally { await prisma.$executeRaw`ALTER TABLE "ProductDailyRestoreAudit" DROP CONSTRAINT round8_test_failure`; }
    expect(await sweep('2026-10-11T20:00:00Z')).toBe(2);
    expect(await prisma.merchantDailyRestoreRun.findFirstOrThrow({ where: { merchantId } })).toMatchObject({ restoredCount: 2 });
  });

  it('executes through the enabled lifecycle loop and does not execute through a disabled loop', async () => {
    await toggle(true); await schedule({ time: '00:00' });
    const logs: unknown[] = [];
    const logger = { info: () => undefined, error: (e: unknown) => logs.push(e) };
    const disabled = background.startLifecycleProcessor(prisma, config, logger);
    await new Promise((resolve) => setTimeout(resolve, 30)); disabled();
    expect((await product()).saleStatus).toBe('SOLD_OUT');
    const stop = background.startLifecycleProcessor(prisma, { ...config, enableBackgroundJobs: true }, logger);
    try {
      const deadline = Date.now() + 3000;
      while ((await product()).saleStatus !== 'ON_SALE' && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
      expect((await product()).saleStatus).toBe('ON_SALE');
      expect(logs).toEqual([]);
    } finally { stop(); }
  });

  it('rechecks forged owner bindings and omits all scheduling internals from public role responses', async () => {
    const actor = { id: ownerId, role: 'MERCHANT' as const, merchantId: seedIds.merchant };
    await expect(getDailyRestorePreference(prisma, actor, config.campusTimeZone)).rejects.toMatchObject({ statusCode: 404 });
    await expect(updateDailyRestorePreference(prisma, actor, { enabled: true, expectedVersion: 0, reason: 'forged' }, config.campusTimeZone)).rejects.toMatchObject({ statusCode: 404 });
    await toggle(true);
    for (const id of [seedIds.customer, seedIds.riderAUser, seedIds.admin]) expect((await read(id)).statusCode).toBe(403);
    for (const id of [seedIds.customer, seedIds.riderAUser]) {
      for (const url of ['/merchants', `/merchants/${merchantId}/products`]) {
        const response = await app.inject({ method: 'GET', url, headers: headers(id) });
        expect(response.statusCode).toBe(200);
        for (const field of ['dailyProductRestore', 'dailyRestore', 'preferenceVersion', 'configVersion', 'ownerId', 'exposureState', 'trialExposureOverrideBps', 'subsidy', 'actorId']) expect(response.body).not.toContain(field);
      }
    }
  });

  it('persists one run across independent clients and a restarted worker', async () => {
    await toggle(true);
    const other = new PrismaClient();
    try {
      const clock = () => new Date('2026-10-11T20:00:00Z');
      const counts = await Promise.all([background.restoreDailyProducts(prisma, { ...config, enableBackgroundJobs: true }, clock),
        background.restoreDailyProducts(other, { ...config, enableBackgroundJobs: true }, clock)]);
      expect(counts.sort()).toEqual([0, 1]);
    } finally { await other.$disconnect(); }
    await sale('SOLD_OUT', 2);
    const restarted = new PrismaClient();
    try {
      expect(await background.restoreDailyProducts(restarted, { ...config, enableBackgroundJobs: true }, () => new Date('2026-10-11T23:00:00Z'))).toBe(0);
    } finally { await restarted.$disconnect(); }
    expect(await product()).toMatchObject({ saleStatus: 'SOLD_OUT', version: 3 });
    expect(await prisma.merchantDailyRestoreRun.count({ where: { merchantId } })).toBe(1);
  });

  it('rechecks disabling opt-in after waiting for the owner preference transaction', async () => {
    await toggle(true);
    const held = barrier(), release = barrier();
    const gated = prisma.$extends({ query: { merchant: { async updateMany({ args, query }) {
      const result = await query(args); held.release(); await release.promise; return result;
    } } } });
    const disabling = updateDailyRestorePreference(gated as unknown as PrismaClient, { id: ownerId, role: 'MERCHANT', merchantId },
      { enabled: false, expectedVersion: 1, reason: 'disable before execution' }, config.campusTimeZone);
    await held.promise;
    const restoring = sweep('2026-10-11T20:00:00Z');
    try { await waitForLock('"Merchant"'); } finally { release.release(); }
    await disabling; expect(await restoring).toBe(0);
    expect((await product()).saleStatus).toBe('SOLD_OUT');
    expect(await prisma.merchantDailyRestoreRun.count({ where: { merchantId } })).toBe(0);
  });

  it('reads the committed schedule after waiting for a concurrent admin config writer', async () => {
    await toggle(true);
    const held = barrier(), release = barrier();
    const gated = prisma.$extends({ query: { businessConfig: { async create({ args, query }) {
      const result = await query(args); held.release(); await release.promise; return result;
    } } } });
    const changing = updateBusinessConfig(gated as unknown as PrismaClient, { id: seedIds.admin, role: 'ADMIN', adminLevel: 'SUPER_ADMIN' }, key, { time: '08:00' }, 'defer schedule', 0);
    await held.promise;
    const restoring = sweep('2026-10-11T20:00:00Z');
    try { await waitForLock('pg_advisory_xact_lock_shared'); } finally { release.release(); }
    await changing; expect(await restoring).toBe(0);
    expect((await product()).saleStatus).toBe('SOLD_OUT');
    expect(await prisma.merchantDailyRestoreRun.count({ where: { merchantId } })).toBe(0);
  });

  it('respects an off-shelf manual transaction that precedes the worker', async () => {
    await toggle(true);
    const held = barrier(), release = barrier();
    const editing = prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "Merchant" WHERE "id"=${merchantId}::uuid FOR SHARE`;
      await tx.product.update({ where: { id: soldId }, data: { saleStatus: 'OFF_SHELF', version: { increment: 1 } } });
      held.release(); await release.promise;
    });
    await held.promise;
    const restoring = sweep('2026-10-11T20:00:00Z');
    try { await waitForLock('"Merchant"'); } finally { release.release(); }
    await editing; expect(await restoring).toBe(0);
    expect(await product()).toMatchObject({ saleStatus: 'OFF_SHELF', version: 2 });
  });

  it('holds readers and manual CAS behind an automatic batch then preserves new manual sold-out status', async () => {
    await toggle(true);
    const held = barrier(), release = barrier();
    const gated = prisma.$extends({ query: { merchantDailyRestoreRun: { async create({ args, query }) {
      const result = await query(args); held.release(); await release.promise; return result;
    } } } });
    const restoring = background.restoreDailyProducts(gated as unknown as PrismaClient, { ...config, enableBackgroundJobs: true }, () => new Date('2026-10-11T20:00:00Z'));
    await held.promise;
    const editing = sale('SOLD_OUT', 1), quoting = preview(soldId);
    const creating = app.inject({ method: 'POST', url: '/orders', headers: headers(seedIds.customer), payload: input() });
    try { await waitForLock('"Merchant"'); } finally { release.release(); }
    expect(await restoring).toBe(1);
    expect((await editing).statusCode).toBe(409);
    expect((await quoting).statusCode).toBe(200);
    expect((await creating).statusCode).toBe(201);
    expect((await sale('SOLD_OUT', 2)).statusCode).toBe(200);
    expect(await sweep('2026-10-11T21:00:00Z')).toBe(0);
    expect(await product()).toMatchObject({ saleStatus: 'SOLD_OUT', version: 3 });
  });

  it('waits for an earlier order creation and preserves its snapshot and required fragile evidence', async () => {
    await toggle(true);
    const held = barrier(), release = barrier();
    const gated = prisma.$extends({ query: { order: { async create({ args, query }) {
      const result = await query(args); held.release(); await release.promise; return result;
    } } } });
    const creating = createOrder(gated as unknown as PrismaClient, { id: seedIds.customer, role: 'CUSTOMER' }, input(), config.campusTimeZone);
    await held.promise;
    const restoring = sweep('2026-10-11T20:00:00Z');
    try { await waitForLock('"Merchant"'); } finally { release.release(); }
    const created = await creating;
    const snapshot = await prisma.order.findUniqueOrThrow({ where: { id: created.id }, include: { items: true, pricing: true, events: true } });
    expect(await restoring).toBe(1);
    expect(await prisma.order.findUniqueOrThrow({ where: { id: created.id }, include: { items: true, pricing: true, events: true } })).toEqual(snapshot);
    expect(snapshot).toMatchObject({ status: 'CREATED', pickupEvidenceLevel: 'REQUIRED', coreFragileValueMinor: 6000 });
  });

  it('waits for a protected price reader and invalidates a pre-recovery quote token', async () => {
    await toggle(true);
    const quote = await preview(); expect(quote.statusCode).toBe(200);
    const held = barrier(), release = barrier();
    const reading = prisma.$transaction(async (tx) => {
      const facts = await readCheckoutFacts(tx, input(), checkoutQuantities(input()));
      held.release(); await release.promise; return facts.products[0]!.version;
    });
    await held.promise;
    const restoring = sweep('2026-10-11T20:00:00Z');
    try { await waitForLock('"Merchant"'); } finally { release.release(); }
    expect(await reading).toBe(1); expect(await restoring).toBe(1);
    await sale('ON_SALE', 2);
    // A token for the same product must be stale even when the recovered sale status is again ON_SALE.
    await prisma.product.update({ where: { id: onSaleId }, data: { saleStatus: 'SOLD_OUT', version: { increment: 1 } } });
    await sweep('2026-10-12T20:00:00Z');
    const order = await app.inject({ method: 'POST', url: '/orders', headers: headers(seedIds.customer), payload: { ...input(), expectedQuoteToken: quote.json().quoteToken } });
    expect(order.statusCode).toBe(409);
    expect(await prisma.order.count({ where: { merchantId } })).toBe(0);
  });

  it('serializes legacy boolean writers and keeps historical false hidden after recovery', async () => {
    await toggle(true);
    const held = barrier(), release = barrier();
    const editing = prisma.$transaction(async (tx) => {
      await tx.product.update({ where: { id: onSaleId }, data: { isAvailable: false } });
      held.release(); await release.promise;
    });
    await held.promise;
    const restoring = sweep('2026-10-11T20:00:00Z');
    try { await waitForLock('"Product"'); } finally { release.release(); }
    await editing; expect(await restoring).toBe(1);
    expect(await prisma.product.findUniqueOrThrow({ where: { id: onSaleId } })).toMatchObject({ saleStatus: 'OFF_SHELF', isAvailable: false, version: 1 });
    await prisma.product.update({ where: { id: soldId }, data: { isAvailable: false } });
    expect(await sweep('2026-10-11T21:00:00Z')).toBe(0);
    expect(await product()).toMatchObject({ saleStatus: 'OFF_SHELF', isAvailable: false, version: 2 });
    const menu = await app.inject({ method: 'GET', url: `/merchants/${merchantId}/products`, headers: headers(seedIds.customer) });
    expect(menu.json().categories[0].products).toEqual([]);
  });

  it('uses live time after merchant waits and drops a batch crossing midnight during product waits', async () => {
    await toggle(true);
    let instant = new Date('2026-10-11T19:59:59Z');
    const held = barrier(), release = barrier();
    const blocker = prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "Merchant" WHERE "id"=${merchantId}::uuid FOR UPDATE`;
      held.release(); await release.promise;
    });
    await held.promise;
    const restoring = background.restoreDailyProducts(prisma, { ...config, enableBackgroundJobs: true }, () => instant);
    try { await waitForLock('"Merchant"'); instant = new Date('2026-10-11T20:00:00Z'); } finally { release.release(); }
    await blocker; expect(await restoring).toBe(1);
    await sale('SOLD_OUT', 2);
    instant = new Date('2026-10-13T15:59:59Z');
    const heldProduct = barrier(), releaseProduct = barrier();
    const productBlocker = prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "Product" WHERE "id"=${soldId}::uuid FOR UPDATE`;
      heldProduct.release(); await releaseProduct.promise;
    });
    await heldProduct.promise;
    const crossing = background.restoreDailyProducts(prisma, { ...config, enableBackgroundJobs: true }, () => instant);
    try { await waitForLock('"Product"'); instant = new Date('2026-10-13T16:00:00Z'); } finally { releaseProduct.release(); }
    await productBlocker; expect(await crossing).toBe(0);
    expect(await product()).toMatchObject({ saleStatus: 'SOLD_OUT', version: 3 });
    expect(await prisma.merchantDailyRestoreRun.count({ where: { merchantId } })).toBe(1);
  });
});
