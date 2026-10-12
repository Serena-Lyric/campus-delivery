import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { seedDatabase, seedIds } from '../../prisma/seed.js';

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
  beforeAll(async () => { await seedDatabase(prisma); app = await buildApp(config, prisma); await app.ready(); });
  beforeEach(async () => {
    await prisma.businessConfigAudit.deleteMany({ where: { key } });
    await prisma.businessConfig.deleteMany({ where: { key } });
    ownerId = (await prisma.user.create({ data: { role: 'MERCHANT', displayName: 'daily owner' } })).id;
    merchantId = (await prisma.merchant.create({ data: { ownerId, name: 'daily stall', exposureState: 'NORMAL', campusLocationId: seedIds.merchantLocation } })).id;
  });
  afterAll(async () => {
    // Added models are cleaned with SQL so the RED test can run before generation.
    const tables = await prisma.$queryRaw<Array<{ name: string }>>`SELECT tablename AS name FROM pg_tables WHERE schemaname='public'`;
    for (const table of ['ProductDailyRestoreAudit', 'MerchantDailyRestoreRun', 'MerchantDailyRestorePreferenceAudit']) {
      if (tables.some((t) => t.name === table)) await prisma.$executeRawUnsafe(`DELETE FROM "${table}"`);
    }
    await prisma.merchant.deleteMany({ where: { name: 'daily stall' } });
    await prisma.user.deleteMany({ where: { displayName: 'daily owner' } });
    await prisma.businessConfigAudit.deleteMany({ where: { key } });
    await prisma.businessConfig.deleteMany({ where: { key } });
    await app.close(); await prisma.$disconnect();
  });
  const read = (id = ownerId) => app.inject({ method: 'GET', url: '/merchant/daily-product-restore', headers: headers(id) });
  const toggle = (enabled: boolean, expectedVersion = 0, id = ownerId, extra = {}) => app.inject({ method: 'PUT',
    url: '/merchant/daily-product-restore', headers: headers(id), payload: { enabled, expectedVersion, reason: 'opt in', ...extra } });
  const schedule = (payload: object, expectedVersion: number | undefined = 0, extra = {}, id: string = seedIds.admin) => app.inject({ method: 'PUT',
    url: `/admin/business-configs/${key}`, headers: headers(id), payload: { payload, reason: 'schedule', expectedVersion, ...extra } });

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
    await prisma.merchant.create({ data: { ownerId: other.id, name: 'daily stall', campusLocationId: seedIds.merchantLocation } });
    expect((await toggle(true, 0, other.id)).statusCode).toBe(200);
    expect((await read()).json()).toMatchObject({ enabled: false, version: 0 });
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
});
