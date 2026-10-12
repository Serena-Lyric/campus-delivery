import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../../src/app.js';
import { seedDatabase, seedIds } from '../../prisma/seed.js';
import { confirmBusinessDay, getOperatingStatus, updateOperatingStatus } from '../../src/catalog/operating-status.js';
import { updateDailyConfirmationPreference } from '../../src/catalog/daily-confirmation-preference.js';
import { restoreDailyProducts } from '../../src/catalog/daily-restore.js';
import { releaseExpiredCoolingOrders } from '../../src/orders/lifecycle.js';

const prisma = new PrismaClient();
const config = { databaseUrl: process.env.DATABASE_URL!, host: '127.0.0.1', port: 3000,
  enableDevAuth: true, enableBackgroundJobs: false, backgroundSweepIntervalMs: 5000,
  campusTimeZone: 'Asia/Shanghai', logLevel: 'silent' as const };
const key = 'MERCHANT_DAILY_CONFIRMATION';
const headers = (id: string) => ({ 'x-user-id': id });
function barrier() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}
async function waitForLock(pattern: string) {
  const deadline = performance.now() + 3000;
  while (performance.now() < deadline) {
    const [row] = await prisma.$queryRaw<Array<{ waiting: boolean }>>`SELECT EXISTS(SELECT 1 FROM pg_stat_activity
      WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE ${`%${pattern}%`}) AS waiting`;
    if (row?.waiting) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`No observed PostgreSQL lock wait: ${pattern}`);
}
describe('merchant daily confirmation', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let ownerId: string;
  let merchantId: string;
  let productId: string;
  async function clean() {
    await prisma.deliveryTask.deleteMany({ where: { order: { merchant: { name: 'confirmation stall' } } } });
    await prisma.order.deleteMany({ where: { merchant: { name: 'confirmation stall' } } });
    await prisma.merchantOperatingStatusAudit.deleteMany({ where: { merchant: { name: 'confirmation stall' } } });
    await prisma.productSaleStatusAudit.deleteMany({ where: { merchant: { name: 'confirmation stall' } } });
    await prisma.productDailyRestoreAudit.deleteMany({ where: { run: { merchant: { name: 'confirmation stall' } } } });
    await prisma.merchantDailyRestoreRun.deleteMany({ where: { merchant: { name: 'confirmation stall' } } });
    await prisma.merchantDailyRestorePreferenceAudit.deleteMany({ where: { merchant: { name: 'confirmation stall' } } });
    const tables = await prisma.$queryRaw<Array<{ name: string }>>`SELECT tablename AS name FROM pg_tables WHERE schemaname='public'`;
    for (const table of ['MerchantBusinessDayConfirmation', 'MerchantDailyConfirmationPreferenceAudit']) {
      if (tables.some((t) => t.name === table)) await prisma.$executeRawUnsafe(`DELETE FROM "${table}"`);
    }
    await prisma.merchant.deleteMany({ where: { name: 'confirmation stall' } });
    await prisma.user.deleteMany({ where: { displayName: 'confirmation owner' } });
    await prisma.businessConfigAudit.deleteMany({ where: { key: { in: [key, 'PRODUCT_DAILY_RESTORE'] } } });
    await prisma.businessConfig.deleteMany({ where: { key: { in: [key, 'PRODUCT_DAILY_RESTORE'] } } });
    const riders = await prisma.rider.findMany({ where: { user: { displayName: 'confirmation lifecycle rider' } }, select: { id: true, userId: true } });
    await prisma.riderCapacityEvent.deleteMany({ where: { riderId: { in: riders.map((r) => r.id) } } });
    await prisma.rider.deleteMany({ where: { id: { in: riders.map((r) => r.id) } } });
    await prisma.user.deleteMany({ where: { id: { in: riders.map((r) => r.userId) } } });
  }
  beforeAll(async () => { await seedDatabase(prisma); await clean(); app = await buildApp(config, prisma); await app.ready(); });
  beforeEach(async () => {
    await clean();
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-10-12T04:00:00Z'));
    ownerId = (await prisma.user.create({ data: { role: 'MERCHANT', displayName: 'confirmation owner' } })).id;
    merchantId = (await prisma.merchant.create({ data: { ownerId, name: 'confirmation stall', exposureState: 'NORMAL', campusLocationId: seedIds.merchantLocation } })).id;
    const category = await prisma.productCategory.create({ data: { merchantId, name: 'confirmation menu' } });
    productId = (await prisma.product.create({ data: { merchantId, categoryId: category.id, name: 'meal', priceMinor: 1500, deliveryCategoryCode: 'ORDINARY_MEAL' } })).id;
  });
  afterEach(() => vi.useRealTimers());
  afterAll(async () => { await clean(); await app?.close(); await prisma.$disconnect(); });
  const read = () => app.inject({ method: 'GET', url: '/merchant/daily-confirmation', headers: headers(ownerId) });
  const toggle = (enabled: boolean, expectedVersion = 0, id = ownerId, extra = {}) => app.inject({ method: 'PUT', url: '/merchant/daily-confirmation',
    headers: headers(id), payload: { enabled, expectedVersion, reason: 'owner choice', ...extra } });
  const schedule = (payload: object, expectedVersion: number | undefined = 0, id: string = seedIds.admin, extra = {}) => app.inject({ method: 'PUT',
    url: `/admin/business-configs/${key}`, headers: headers(id), payload: { payload, expectedVersion, reason: 'safe transition', ...extra } });
  const operating = () => app.inject({ method: 'GET', url: '/merchant/operating-status', headers: headers(ownerId) });
  const manual = (isOpen: boolean, expectedVersion: number) => app.inject({ method: 'PUT', url: '/merchant/operating-status',
    headers: headers(ownerId), payload: { isOpen, expectedVersion, reason: 'manual operation' } });
  const confirm = (expectedVersion: number, id = ownerId, extra = {}) => app.inject({ method: 'POST', url: '/merchant/confirm-business-day',
    headers: headers(id), payload: { expectedVersion, reason: 'confirm business', ...extra } });
  const input = () => ({ merchantId, destinationLocationId: seedIds.dormLocation, deliveryMethod: 'DESIGNATED_POINT', items: [{ productId, quantity: 1 }] });
  const preview = () => app.inject({ method: 'POST', url: '/orders/price-preview', headers: headers(seedIds.customer), payload: input() });
  const order = (expectedQuoteToken?: string) => app.inject({ method: 'POST', url: '/orders', headers: headers(seedIds.customer), payload: { ...input(), expectedQuoteToken } });
  const menu = () => app.inject({ method: 'GET', url: `/merchants/${merchantId}/products`, headers: headers(seedIds.customer) });

  it('defaults off; enabling waits for the next business day, disabling is immediate without opening', async () => {
    const original = await prisma.merchant.findUniqueOrThrow({ where: { id: merchantId } });
    const initial = await read(); expect(initial.statusCode, initial.body).toBe(200);
    const docs = app.swagger() as { paths: Record<string, { get: { responses: Record<string, { content?: Record<string, { schema: { properties: Record<string, unknown> } }> }> } }> };
    expect(docs.paths['/merchant/daily-confirmation']!.get.responses['200']!.content?.['application/json']?.schema.properties ?? {}).toHaveProperty('pendingActivation');
    expect(initial.json()).toMatchObject({ enabled: false, version: 0, active: false, pendingActivation: false, confirmedToday: false,
      businessDay: '2026-10-12', schedule: { time: '04:00', version: 0, source: 'SYSTEM_DEFAULT', timeZone: 'Asia/Shanghai' } });
    const enabled = await toggle(true); expect(enabled.statusCode, enabled.body).toBe(200);
    expect(enabled.json()).toMatchObject({ enabled: true, version: 1, active: false, pendingActivation: true, effectiveAt: '2026-10-12T20:00:00.000Z' });
    expect((await toggle(true, 1)).json()).toMatchObject({ changed: false, version: 1 });
    expect((await toggle(false, 0)).statusCode).toBe(409);
    vi.setSystemTime(new Date('2026-10-12T19:59:59.999Z')); expect((await read()).json().active).toBe(false);
    vi.setSystemTime(new Date('2026-10-12T20:00:00Z')); expect((await read()).json()).toMatchObject({ active: true, pendingActivation: false, businessDay: '2026-10-13' });
    await prisma.merchant.update({ where: { id: merchantId }, data: { isOpen: false } });
    expect((await toggle(false, 1)).json()).toMatchObject({ enabled: false, active: false, effectiveAt: null, version: 2 });
    expect((await toggle(true, 2)).json()).toMatchObject({ active: false, effectiveAt: '2026-10-13T20:00:00.000Z' });
    const final = await prisma.merchant.findUniqueOrThrow({ where: { id: merchantId } });
    expect(final).toMatchObject({ isOpen: false, operatingVersion: original.operatingVersion, dailyProductRestoreEnabled: false, dailyProductRestoreVersion: 0 });
    expect((await read()).json().history).toHaveLength(3);
  });
  it('enforces owner, strict payload, CAS and same-value audit semantics', async () => {
    for (const id of [seedIds.customer, seedIds.riderAUser, seedIds.admin]) expect((await toggle(true, 0, id)).statusCode).toBe(403);
    for (const extra of [{ merchantId: seedIds.merchant }, { time: '05:00' }, { isOpen: true }, { effectiveAt: '2026-01-01' }]) expect((await toggle(true, 0, ownerId, extra)).statusCode).toBe(400);
    const results = await Promise.all([toggle(true), toggle(true)]);
    expect(results.map((r) => r.statusCode).sort()).toEqual([200, 409]);
    expect((await toggle(true, 1)).json().changed).toBe(false);
    expect((await read()).json().history).toHaveLength(1);
    expect(await prisma.merchant.findUniqueOrThrow({ where: { id: seedIds.merchant } })).toMatchObject({ dailyConfirmationEnabled: false, dailyConfirmationVersion: 0 });
  });
  it('validates independent admin configuration and defers later/earlier boundaries without retroactive change', async () => {
    for (const payload of [{ time: '24:00' }, { time: '4:00' }, { time: '04:60' }, { time: '08:00', effectiveAt: 'now' }, { time: '08:00', merchantId }]) expect((await schedule(payload)).statusCode).toBe(400);
    expect((await schedule({ time: '08:00' }, 0, seedIds.admin, { expectedVersion: undefined })).statusCode).toBe(400);
    expect((await schedule({ time: '08:00' }, 0, seedIds.operator)).statusCode).toBe(403);
    expect((await schedule({ time: '08:00' }, 0, seedIds.admin, { merchantId })).statusCode).toBe(400);
    const before = await prisma.businessConfig.findMany({ where: { key: 'PRODUCT_DAILY_RESTORE' } });
    const responses = await Promise.all([schedule({ time: '08:00' }), schedule({ time: '06:00' })]);
    expect(responses.map((r) => r.statusCode).sort()).toEqual([200, 409]);
    const chosen = responses.find((r) => r.statusCode === 200)!.json().payload.time;
    expect((await schedule({ time: chosen }, 1)).json().version).toBe(1);
    expect(await prisma.businessConfigAudit.count({ where: { key } })).toBe(1);
    expect((await read()).json()).toMatchObject({ businessDay: '2026-10-12', schedule: { time: '04:00', version: 0, configuredTime: chosen, configuredVersion: 1, pending: true } });
    vi.setSystemTime(new Date('2026-10-12T20:01:00Z'));
    expect((await read()).json().businessDay).toBe('2026-10-12');
    // Return to the write instant before replacing a still-pending policy.
    vi.setSystemTime(new Date('2026-10-12T04:00:00Z'));
    const replacement = await schedule({ time: '02:00' }, 1); expect(replacement.statusCode).toBe(200);
    vi.setSystemTime(new Date('2026-10-12T19:59:59Z')); expect((await read()).json().businessDay).toBe('2026-10-12');
    vi.setSystemTime(new Date('2026-10-12T20:00:00Z')); expect((await read()).json().businessDay).toBe('2026-10-12');
    vi.setSystemTime(new Date(replacement.json().payload.effectiveAt)); expect((await read()).json()).toMatchObject({ businessDay: '2026-10-13', schedule: { time: '02:00', version: 2, pending: false } });
    expect(await prisma.businessConfig.findMany({ where: { key: 'PRODUCT_DAILY_RESTORE' } })).toEqual(before);
  });
  it('synchronously denies preview and creation at 04:00 with jobs disabled, preserving menus, manual state and old orders', async () => {
    await toggle(true);
    const quote = await preview(); expect(quote.statusCode, quote.body).toBe(200);
    const created = await order(quote.json().quoteToken); expect(created.statusCode, created.body).toBe(201);
    const previous = await prisma.order.findUniqueOrThrow({ where: { id: created.json().id }, include: { items: true, pricing: true, events: true } });
    vi.setSystemTime(new Date('2026-10-12T19:59:59.999Z')); expect((await preview()).statusCode).toBe(200);
    vi.setSystemTime(new Date('2026-10-12T20:00:00Z'));
    const blocked = await preview(); expect(blocked.statusCode, blocked.body).toBe(409);
    expect((await order(quote.json().quoteToken)).statusCode).toBe(409);
    const listed = await app.inject({ method: 'GET', url: '/merchants', headers: headers(seedIds.customer) });
    expect(listed.json().find((m: { id: string }) => m.id === merchantId)).toMatchObject({ isOpen: true, acceptingOrders: false, operatingStatusLabel: '休息中', businessDay: '2026-10-13', confirmedToday: false });
    expect((await menu()).json()).toMatchObject({ acceptingOrders: false, operatingStatusLabel: '休息中', categories: [{ products: [{ id: productId, saleStatus: 'ON_SALE', purchasable: false }] }] });
    expect((await operating()).json()).toMatchObject({ isOpen: true, acceptingOrders: false, operatingStatusLabel: '待今日确认', confirmationRequired: true, confirmedToday: false });
    expect(await prisma.merchant.findUniqueOrThrow({ where: { id: merchantId } })).toMatchObject({ isOpen: true, operatingVersion: 0, exposureState: 'NORMAL' });
    expect(await prisma.order.findUniqueOrThrow({ where: { id: previous.id }, include: { items: true, pricing: true, events: true } })).toEqual(previous);
    const other = await app.inject({ method: 'POST', url: '/orders/price-preview', headers: headers(seedIds.customer), payload: {
      ...input(), merchantId: seedIds.merchant, items: [{ productId: seedIds.productRice, quantity: 1 }] } });
    expect(other.statusCode, other.body).toBe(200);
  });
  it('same-value manual opening confirms an expired day; close and reopen retain one truthful confirmation', async () => {
    await toggle(true); vi.setSystemTime(new Date('2026-10-12T20:00:00Z'));
    const first = await manual(true, 0); expect(first.statusCode, first.body).toBe(200);
    expect(first.json()).toMatchObject({ changed: true, isOpen: true, operatingVersion: 1, confirmedToday: true, acceptingOrders: true,
      confirmation: { source: 'MANUAL_OPEN', actorId: ownerId, businessDay: '2026-10-13', policyVersion: 0, switchingTime: '04:00', timeZone: 'Asia/Shanghai' },
      audit: { previousIsOpen: true, newIsOpen: true, version: 1 } });
    expect((await manual(true, 0)).statusCode).toBe(409);
    expect((await manual(true, 1)).json()).toMatchObject({ changed: false, operatingVersion: 1 });
    expect((await confirm(1)).json()).toMatchObject({ changed: false, operatingVersion: 1 });
    expect((await manual(false, 1)).json()).toMatchObject({ isOpen: false, confirmedToday: true, acceptingOrders: false, operatingVersion: 2 });
    expect((await manual(true, 2)).json()).toMatchObject({ isOpen: true, confirmedToday: true, acceptingOrders: true, operatingVersion: 3 });
    const rows = await prisma.$queryRaw<Array<{ source: string; actorId: string; operatingVersion: number }>>`SELECT "source", "actorId", "operatingVersion" FROM "MerchantBusinessDayConfirmation" WHERE "merchantId"=${merchantId}::uuid`;
    expect(rows).toEqual([{ source: 'MANUAL_OPEN', actorId: ownerId, operatingVersion: 1 }]);
    expect((await read()).json().confirmedToday).toBe(true);
    expect((await menu()).json().categories[0].products[0].purchasable).toBe(true);
    vi.setSystemTime(new Date('2026-10-13T20:00:00Z')); expect((await preview()).statusCode).toBe(409);
    expect((await confirm(3)).json()).toMatchObject({ changed: true, isOpen: true, operatingVersion: 4, confirmedToday: true, confirmation: { source: 'EXPLICIT_CONFIRM', businessDay: '2026-10-14' } });
    expect((await preview()).statusCode).toBe(200);
  });
  it('confirms and opens atomically with CAS, owner and strict-body checks; default manual no-op stays a no-op', async () => {
    expect((await manual(true, 0)).json()).toMatchObject({ changed: false, operatingVersion: 0 });
    for (const id of [seedIds.customer, seedIds.riderAUser, seedIds.admin]) expect((await confirm(0, id)).statusCode).toBe(403);
    for (const extra of [{ merchantId: seedIds.merchant }, { actorId: seedIds.admin }, { businessDay: '2026-10-13' }, { time: '02:00' }]) expect((await confirm(0, ownerId, extra)).statusCode).toBe(400);
    await manual(false, 0);
    const responses = await Promise.all([confirm(1), confirm(1)]);
    expect(responses.map((r) => r.statusCode).sort()).toEqual([200, 409]);
    expect(responses.find((r) => r.statusCode === 200)!.json()).toMatchObject({ isOpen: true, operatingVersion: 2, confirmedToday: true });
    expect((await confirm(2)).json()).toMatchObject({ changed: false, operatingVersion: 2 });
    expect((await operating()).json().history).toHaveLength(2);
    expect(await prisma.$queryRaw<Array<{ count: bigint }>>`SELECT count(*) FROM "MerchantBusinessDayConfirmation" WHERE "merchantId"=${merchantId}::uuid`).toEqual([{ count: 1n }]);
  });
  it('opt-out immediately restores only the confirmation dimension and re-enabling waits again', async () => {
    await toggle(true); vi.setSystemTime(new Date('2026-10-12T20:00:00Z'));
    expect((await preview()).statusCode).toBe(409);
    expect((await toggle(false, 1)).json()).toMatchObject({ active: false, enabled: false });
    expect((await preview()).statusCode).toBe(200);
    expect(await prisma.merchant.findUniqueOrThrow({ where: { id: merchantId } })).toMatchObject({ isOpen: true, operatingVersion: 0 });
    await manual(false, 0); await toggle(true, 2);
    vi.setSystemTime(new Date('2026-10-13T20:00:00Z'));
    expect((await toggle(false, 3)).statusCode).toBe(200);
    expect((await operating()).json()).toMatchObject({ isOpen: false, acceptingOrders: false, confirmationRequired: false });
    expect((await preview()).statusCode).toBe(409);
  });
  it('preserves confirmed admission through later and earlier configured switch times until the durable safe transition', async () => {
    await toggle(true); vi.setSystemTime(new Date('2026-10-12T20:00:00Z')); await confirm(0);
    const firstFact = await prisma.merchantBusinessDayConfirmation.findMany({ where: { merchantId } });
    vi.setSystemTime(new Date('2026-10-13T04:00:00Z'));
    const changed = await schedule({ time: '08:00' }); expect(changed.statusCode).toBe(200);
    expect(changed.json().payload).toMatchObject({ effectiveAt: '2026-10-14T00:00:00.000Z', transitionDayStart: '2026-10-12T20:00:00.000Z' });
    for (const at of ['2026-10-13T16:00:00Z', '2026-10-13T20:00:00Z', '2026-10-13T23:59:59.999Z']) {
      vi.setSystemTime(new Date(at)); expect((await preview()).statusCode).toBe(200);
      expect((await operating()).json()).toMatchObject({ businessDay: '2026-10-13', confirmedToday: true, acceptingOrders: true });
    }
    vi.setSystemTime(new Date('2026-10-14T00:00:00Z')); expect((await preview()).statusCode).toBe(409);
    expect((await confirm(1)).json()).toMatchObject({ confirmation: { policyVersion: 1, switchingTime: '08:00', businessDay: '2026-10-14' } });
    vi.setSystemTime(new Date('2026-10-14T04:00:00Z'));
    const earlier = await schedule({ time: '02:00' }, 1); expect(earlier.json().payload.effectiveAt).toBe('2026-10-15T00:00:00.000Z');
    vi.setSystemTime(new Date('2026-10-14T18:00:00Z')); expect((await preview()).statusCode).toBe(200);
    vi.setSystemTime(new Date('2026-10-15T00:00:00Z')); expect((await preview()).statusCode).toBe(409);
    expect((await confirm(2)).json()).toMatchObject({ confirmation: { policyVersion: 2, switchingTime: '02:00', businessDayStartsAt: '2026-10-15T00:00:00.000Z', businessDay: '2026-10-15' } });
    vi.setSystemTime(new Date('2026-10-15T18:00:00Z')); expect((await preview()).statusCode).toBe(409);
    expect(await prisma.merchantBusinessDayConfirmation.findMany({ where: { id: firstFact[0]!.id } })).toEqual(firstFact);
  });
  it('uses the configured campus zone throughout preference, confirmation, catalog, preview and creation; mismatched instances fail closed', async () => {
    const local = await buildApp({ ...config, campusTimeZone: 'America/Los_Angeles' }, prisma); await local.ready();
    const call = (method: 'GET' | 'PUT' | 'POST', url: string, payload?: object, id = ownerId) => local.inject({ method, url, headers: headers(id), ...(payload ? { payload } : {}) });
    try {
      const setting = await call('PUT', `/admin/business-configs/${key}`, { payload: { time: '08:00' }, expectedVersion: 0, reason: 'IANA test' }, seedIds.admin);
      expect(setting.json().payload).toMatchObject({ timeZone: 'America/Los_Angeles', effectiveAt: '2026-10-12T15:00:00.000Z' });
      const enabled = await call('PUT', '/merchant/daily-confirmation', { enabled: true, expectedVersion: 0, reason: 'local opt in' });
      expect(enabled.json()).toMatchObject({ businessDay: '2026-10-11', effectiveAt: '2026-10-12T15:00:00.000Z' });
      vi.setSystemTime(new Date('2026-10-12T15:00:00Z'));
      expect((await call('POST', '/orders/price-preview', input(), seedIds.customer)).statusCode).toBe(409);
      expect((await call('POST', '/merchant/confirm-business-day', { expectedVersion: 0, reason: 'open locally' })).json()).toMatchObject({ businessDay: '2026-10-12', confirmation: { timeZone: 'America/Los_Angeles', switchingTime: '08:00' } });
      expect((await call('GET', `/merchants/${merchantId}/products`, undefined, seedIds.customer)).json()).toMatchObject({ businessDay: '2026-10-12', acceptingOrders: true });
      const quote = await call('POST', '/orders/price-preview', input(), seedIds.customer); expect(quote.statusCode).toBe(200);
      expect((await call('POST', '/orders', { ...input(), expectedQuoteToken: quote.json().quoteToken }, seedIds.customer)).statusCode).toBe(201);
      expect((await preview()).statusCode).toBe(500);
      expect((await read()).json().code).toBe('CONFIRMATION_TIME_ZONE_MISMATCH');
    } finally { await local.close(); }
  });
  it('retains HIDDEN/SUSPENDED visibility restrictions even after a real confirmation opens the manual switch', async () => {
    await toggle(true); vi.setSystemTime(new Date('2026-10-12T20:00:00Z'));
    for (const exposureState of ['HIDDEN', 'SUSPENDED'] as const) {
      await prisma.merchant.update({ where: { id: merchantId }, data: { exposureState } });
      const opened = await confirm(exposureState === 'HIDDEN' ? 0 : 1); expect(opened.statusCode).toBe(200);
      expect(opened.json()).toMatchObject({ isOpen: true, confirmedToday: true, acceptingOrders: false });
      expect((await menu()).statusCode).toBe(404); expect((await preview()).statusCode).toBe(409);
      const list = await app.inject({ method: 'GET', url: '/merchants', headers: headers(seedIds.customer) });
      expect(list.json().some((m: { id: string }) => m.id === merchantId)).toBe(false);
      expect(await prisma.merchant.findUniqueOrThrow({ where: { id: merchantId } })).toMatchObject({ exposureState, isOpen: true });
    }
  });
  it('keeps the round-eight natural-date product restore independent and never treats the system job as a business confirmation', async () => {
    await schedule({ time: '06:00' }); await toggle(true);
    const setting = await app.inject({ method: 'PUT', url: '/admin/business-configs/PRODUCT_DAILY_RESTORE', headers: headers(seedIds.admin),
      payload: { payload: { time: '07:30' }, expectedVersion: 0, reason: 'separate restore time' } }); expect(setting.statusCode).toBe(200);
    expect((await app.inject({ method: 'PUT', url: '/merchant/daily-product-restore', headers: headers(ownerId), payload: { enabled: true, expectedVersion: 0, reason: 'restore products' } })).statusCode).toBe(200);
    await prisma.product.update({ where: { id: productId }, data: { saleStatus: 'SOLD_OUT', version: { increment: 1 } } });
    vi.setSystemTime(new Date('2026-10-12T20:00:00Z')); expect((await operating()).json().acceptingOrders).toBe(true);
    vi.setSystemTime(new Date('2026-10-12T22:00:00Z')); expect((await operating()).json().acceptingOrders).toBe(false);
    expect(await restoreDailyProducts(prisma, { ...config, enableBackgroundJobs: true })).toBe(0);
    vi.setSystemTime(new Date('2026-10-12T23:30:00Z')); expect(await restoreDailyProducts(prisma, { ...config, enableBackgroundJobs: true })).toBe(1);
    expect(await prisma.product.findUniqueOrThrow({ where: { id: productId } })).toMatchObject({ saleStatus: 'ON_SALE', version: 3 });
    expect(await prisma.merchantBusinessDayConfirmation.count({ where: { merchantId } })).toBe(0);
    expect(await prisma.merchantDailyRestoreRun.findFirst({ where: { merchantId } })).toMatchObject({ day: new Date('2026-10-13T00:00:00Z'), scheduledTime: '07:30', configVersion: 1, source: 'AUTO_DAILY' });
    expect((await preview()).statusCode).toBe(409); expect((await menu()).json().categories[0].products[0].purchasable).toBe(false);
    expect(await prisma.merchant.findUniqueOrThrow({ where: { id: merchantId } })).toMatchObject({ isOpen: true, operatingVersion: 0 });
  });
  it('serializes independent client confirmation/manual-open competition and refuses forged owner bindings', async () => {
    await toggle(true); vi.setSystemTime(new Date('2026-10-12T20:00:00Z'));
    const actor = { id: ownerId, role: 'MERCHANT' as const, merchantId };
    const second = new PrismaClient(); await second.$connect();
    try {
      const responses = await Promise.allSettled([confirmBusinessDay(prisma, actor, { expectedVersion: 0, reason: 'explicit' }, config.campusTimeZone),
        updateOperatingStatus(second, actor, { isOpen: true, expectedVersion: 0, reason: 'manual' }, config.campusTimeZone)]);
      expect(responses.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      const failure = responses.find((r) => r.status === 'rejected'); expect(failure?.status === 'rejected' && failure.reason).toMatchObject({ code: 'OPERATING_VERSION_CONFLICT' });
      expect(await prisma.merchantBusinessDayConfirmation.count({ where: { merchantId } })).toBe(1);
      expect((await confirm(1)).json().changed).toBe(false);
      const forged = { ...actor, merchantId: seedIds.merchant };
      await expect(getOperatingStatus(prisma, forged)).rejects.toMatchObject({ statusCode: 404 });
      await expect(confirmBusinessDay(prisma, forged, { expectedVersion: 0, reason: 'forged' })).rejects.toMatchObject({ statusCode: 404 });
      await expect(updateDailyConfirmationPreference(prisma, forged, { enabled: true, expectedVersion: 0, reason: 'forged' }, config.campusTimeZone)).rejects.toMatchObject({ statusCode: 404 });
    } finally { await second.$disconnect(); }
  });
  it('takes live time after configuration, merchant and product lock waits for both preview and order creation', async () => {
    await toggle(true); vi.setSystemTime(new Date('2026-10-12T20:00:00Z')); await confirm(0);
    const token = (await preview()).json().quoteToken;
    for (const lock of ['config', 'Merchant', 'Product'] as const) {
      for (const action of ['preview', 'create'] as const) {
        vi.setSystemTime(new Date('2026-10-13T19:59:59.999Z'));
        const held = barrier(), release = barrier();
        const blocking = prisma.$transaction(async (tx) => {
          if (lock === 'config') await tx.$executeRaw`SELECT pg_advisory_xact_lock(17201014)`;
          else if (lock === 'Merchant') await tx.$queryRaw`SELECT "id" FROM "Merchant" WHERE "id"=${merchantId}::uuid FOR UPDATE`;
          else await tx.$queryRaw`SELECT "id" FROM "Product" WHERE "id"=${productId}::uuid FOR UPDATE`;
          held.release(); await release.promise;
        });
        await held.promise;
        const waiting = action === 'preview' ? preview() : order(token);
        try { await waitForLock(lock === 'config' ? 'pg_advisory_xact_lock_shared' : `"${lock}"`); vi.setSystemTime(new Date('2026-10-13T20:00:00Z')); }
        finally { release.release(); }
        await blocking;
        const response = await waiting; expect(response.statusCode, `${lock}/${action}: ${response.body}`).toBe(409);
      }
    }
    expect(await prisma.order.count({ where: { merchantId } })).toBe(0);
    expect(await prisma.merchant.findUniqueOrThrow({ where: { id: merchantId } })).toMatchObject({ isOpen: true, operatingVersion: 1 });
  });
  it('serializes confirm-first and opt-out-first against queued checkout using real PostgreSQL locks', async () => {
    await toggle(true); vi.setSystemTime(new Date('2026-10-12T20:00:00Z'));
    for (const action of ['confirm', 'disable'] as const) {
      const held = barrier(), release = barrier();
      const blocking = prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT "id" FROM "Merchant" WHERE "id"=${merchantId}::uuid FOR UPDATE`;
        held.release(); await release.promise;
      });
      await held.promise;
      const changing = action === 'confirm' ? confirm(0) : toggle(false, 1);
      await waitForLock('"Merchant"');
      const quoting = preview();
      try { await waitForLock('FOR SHARE'); } finally { release.release(); }
      await blocking; expect((await changing).statusCode).toBe(200); expect((await quoting).statusCode).toBe(200);
    }
    expect((await operating()).json()).toMatchObject({ isOpen: true, confirmedToday: true, confirmationRequired: false, operatingVersion: 1 });
  });
  it('preserves a contract admitted before a queued manual close; the close applies to later new orders', async () => {
    await toggle(true); vi.setSystemTime(new Date('2026-10-12T20:00:00Z')); await confirm(0);
    const token = (await preview()).json().quoteToken;
    const held = barrier(), release = barrier();
    const blocking = prisma.$transaction(async (tx) => {
      await tx.$executeRaw`LOCK TABLE "Order" IN ACCESS EXCLUSIVE MODE`;
      held.release(); await release.promise;
    });
    await held.promise;
    const creating = order(token); await waitForLock('INSERT INTO "public"."Order"');
    const closing = manual(false, 1);
    try { await waitForLock('"Merchant"'); } finally { release.release(); }
    await blocking; const created = await creating; expect(created.statusCode, created.body).toBe(201); expect((await closing).statusCode).toBe(200);
    expect(await prisma.order.findUniqueOrThrow({ where: { id: created.json().id }, include: { pricing: true, items: true } })).toMatchObject({ status: 'CREATED', items: [{ productNameSnapshot: 'meal', unitPriceMinor: 1500 }], pricing: { platformCommissionMinor: 0 } });
    expect((await preview()).statusCode).toBe(409);
  });
  it('rolls back opening, confirmation and both audits when either journal write fails, then safely retries', async () => {
    await toggle(true); await manual(false, 0); vi.setSystemTime(new Date('2026-10-12T20:00:00Z'));
    const before = await prisma.merchant.findUniqueOrThrow({ where: { id: merchantId } });
    await prisma.$executeRaw`ALTER TABLE "MerchantBusinessDayConfirmation" ADD CONSTRAINT round9_confirm_failure CHECK (false) NOT VALID`;
    try { expect((await confirm(1)).statusCode).toBe(500); } finally { await prisma.$executeRaw`ALTER TABLE "MerchantBusinessDayConfirmation" DROP CONSTRAINT round9_confirm_failure`; }
    expect(await prisma.merchant.findUniqueOrThrow({ where: { id: merchantId } })).toEqual(before);
    expect(await prisma.merchantBusinessDayConfirmation.count({ where: { merchantId } })).toBe(0);
    expect(await prisma.merchantOperatingStatusAudit.count({ where: { merchantId } })).toBe(1);
    expect((await confirm(1)).statusCode).toBe(200);
    vi.setSystemTime(new Date('2026-10-13T20:00:00Z'));
    const confirmed = await prisma.merchant.findUniqueOrThrow({ where: { id: merchantId } });
    await prisma.$executeRaw`ALTER TABLE "MerchantOperatingStatusAudit" ADD CONSTRAINT round9_audit_failure CHECK (false) NOT VALID`;
    try { expect((await confirm(2)).statusCode).toBe(500); } finally { await prisma.$executeRaw`ALTER TABLE "MerchantOperatingStatusAudit" DROP CONSTRAINT round9_audit_failure`; }
    expect(await prisma.merchant.findUniqueOrThrow({ where: { id: merchantId } })).toEqual(confirmed);
    expect(await prisma.merchantBusinessDayConfirmation.count({ where: { merchantId } })).toBe(1);
    expect((await confirm(2)).statusCode).toBe(200); expect(await prisma.merchantBusinessDayConfirmation.count({ where: { merchantId } })).toBe(2);
  });
  it('omits internal preference/configuration/actor and funding fields throughout serialized public catalog and owner status', async () => {
    await toggle(true); vi.setSystemTime(new Date('2026-10-12T20:00:00Z')); await confirm(0);
    const publicViews = [await menu(), await app.inject({ method: 'GET', url: '/merchants', headers: headers(seedIds.customer) })];
    for (const response of publicViews) {
      expect(response.statusCode).toBe(200);
      for (const field of ['ownerId', 'exposureState', 'trialExposureOverrideBps', 'deliveryContributionMinor', 'baseDeliveryPriceMinor', 'subsidyAccount', 'dailyConfirmationEnabled', 'dailyConfirmationVersion', 'dailyConfirmationEffectiveAt', 'configuredTime', 'policyVersion', 'actorId', 'businessDayStartsAt']) expect(response.body).not.toContain(field);
    }
    const own = await operating();
    for (const field of ['ownerId', 'subsidyAccount', 'deliveryContributionMinor', 'baseDeliveryPriceMinor', 'trialExposureOverrideBps', 'exposureDecisions']) expect(own.body).not.toContain(field);
    const docs = app.swagger() as { paths: Record<string, { post: { responses: Record<string, { content?: Record<string, { schema: { properties: Record<string, unknown> } }> }> } }> };
    expect(docs.paths['/merchant/confirm-business-day']!.post.responses['200']!.content?.['application/json']?.schema.properties ?? {}).toHaveProperty('confirmation');
  });
  it('continues old merchant confirmation, fragile pickup and delivery while daily admission is expired; finalized funds and role snapshots never drift', async () => {
    const rider = await prisma.rider.create({ data: { status: 'AVAILABLE', capacityOverride: 10, firstNormalDeliveredAt: new Date('2026-09-20T04:00:00Z'),
      user: { create: { role: 'RIDER', displayName: 'confirmation lifecycle rider' } } } });
    await prisma.product.update({ where: { id: productId }, data: { priceMinor: 6000, deliveryCategoryCode: 'CAKE' } });
    await toggle(true); const quote = await preview(); const created = await order(quote.json().quoteToken); expect(created.statusCode, created.body).toBe(201);
    const orderId = created.json().id as string;
    vi.setSystemTime(new Date('2026-10-12T20:00:00Z')); await releaseExpiredCoolingOrders(prisma);
    expect((await preview()).statusCode).toBe(409);
    const accepted = await app.inject({ method: 'POST', url: `/merchant/orders/${orderId}/confirm`, headers: headers(ownerId) }); expect(accepted.statusCode, accepted.body).toBe(200);
    const taskId = accepted.json().deliveryTask.id as string;
    const claimed = await app.inject({ method: 'POST', url: `/delivery-tasks/${taskId}/claim`, headers: headers(rider.userId) }); expect(claimed.statusCode, claimed.body).toBe(200);
    const assignment = await prisma.deliveryAssignment.findFirstOrThrow({ where: { orderId, status: 'ACTIVE' } });
    const pickupRevision = (await prisma.order.findUniqueOrThrow({ where: { id: orderId } })).pickupHandoffRevision;
    const pickup = (photoEvidenceId?: string) => app.inject({ method: 'POST', url: `/merchant/orders/${orderId}/confirm-rider-pickup`, headers: headers(ownerId),
      payload: { assignmentId: assignment.id, expectedRevision: pickupRevision, requestKey: randomUUID(), ...(photoEvidenceId ? { photoEvidenceId } : {}) } });
    expect((await pickup()).statusCode).toBe(409);
    const photo = await app.inject({ method: 'POST', url: `/orders/${orderId}/evidence`, headers: headers(rider.userId),
      payload: { evidenceType: 'RIDER_PICKUP_PHOTO', media: { fileName: 'pickup.jpg', contentType: 'image/jpeg', source: 'CAMERA' } } }); expect(photo.statusCode).toBe(201);
    // Isolated fixture: PostgreSQL DEFAULT now() does not follow Vitest's injected server clock.
    await prisma.evidence.update({ where: { id: photo.json().id }, data: { createdAt: assignment.claimedAt } });
    const pickedUp = await pickup(photo.json().id); expect(pickedUp.statusCode, pickedUp.body).toBe(200);
    const delivered = await app.inject({ method: 'POST', url: `/delivery-tasks/${taskId}/deliver`, headers: headers(rider.userId), payload: {} }); expect(delivered.statusCode, delivered.body).toBe(200);
    const full = () => prisma.order.findUniqueOrThrow({ where: { id: orderId }, include: { items: true, pricing: true, events: { orderBy: { id: 'asc' } }, deliveryTask: true, assignments: true, settlement: true, riderSettlement: true } });
    const finalized = await full(); expect(finalized).toMatchObject({ settlement: { status: 'FINALIZED' }, riderSettlement: { amountMinor: 200 }, pickupEvidenceLevel: 'REQUIRED' });
    expect(await prisma.merchantBusinessDayConfirmation.count({ where: { merchantId } })).toBe(0);
    await confirm(0); await manual(false, 1); await toggle(false, 1); await toggle(true, 2);
    vi.setSystemTime(new Date('2026-10-13T20:00:00Z')); await confirm(2); expect(await full()).toEqual(finalized);
    for (const id of [seedIds.customer, ownerId, rider.userId]) {
      const response = await app.inject({ method: 'GET', url: `/orders/${orderId}`, headers: headers(id) }); expect(response.statusCode).toBe(200);
      for (const field of ['dailyConfirmation', 'businessDayStartsAt', 'switchingTime', 'ownerId', 'platformSubsidyMinor', 'deliveryPricingPolicySnapshot']) expect(response.body).not.toContain(field);
    }
  });
});
