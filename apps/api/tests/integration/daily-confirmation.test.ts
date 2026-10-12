import { PrismaClient } from '@prisma/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../../src/app.js';
import { seedDatabase, seedIds } from '../../prisma/seed.js';

const prisma = new PrismaClient();
const config = { databaseUrl: process.env.DATABASE_URL!, host: '127.0.0.1', port: 3000,
  enableDevAuth: true, enableBackgroundJobs: false, backgroundSweepIntervalMs: 5000,
  campusTimeZone: 'Asia/Shanghai', logLevel: 'silent' as const };
const key = 'MERCHANT_DAILY_CONFIRMATION';
const headers = (id: string) => ({ 'x-user-id': id });
describe('merchant daily confirmation', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let ownerId: string;
  let merchantId: string;
  async function clean() {
    const tables = await prisma.$queryRaw<Array<{ name: string }>>`SELECT tablename AS name FROM pg_tables WHERE schemaname='public'`;
    for (const table of ['MerchantBusinessDayConfirmation', 'MerchantDailyConfirmationPreferenceAudit']) {
      if (tables.some((t) => t.name === table)) await prisma.$executeRawUnsafe(`DELETE FROM "${table}"`);
    }
    await prisma.merchant.deleteMany({ where: { name: 'confirmation stall' } });
    await prisma.user.deleteMany({ where: { displayName: 'confirmation owner' } });
    await prisma.businessConfigAudit.deleteMany({ where: { key } });
    await prisma.businessConfig.deleteMany({ where: { key } });
  }
  beforeAll(async () => { await seedDatabase(prisma); await clean(); app = await buildApp(config, prisma); await app.ready(); });
  beforeEach(async () => {
    await clean();
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-10-12T04:00:00Z'));
    ownerId = (await prisma.user.create({ data: { role: 'MERCHANT', displayName: 'confirmation owner' } })).id;
    merchantId = (await prisma.merchant.create({ data: { ownerId, name: 'confirmation stall', exposureState: 'NORMAL', campusLocationId: seedIds.merchantLocation } })).id;
  });
  afterEach(() => vi.useRealTimers());
  afterAll(async () => { await clean(); await app?.close(); await prisma.$disconnect(); });
  const read = () => app.inject({ method: 'GET', url: '/merchant/daily-confirmation', headers: headers(ownerId) });
  const toggle = (enabled: boolean, expectedVersion = 0, id = ownerId, extra = {}) => app.inject({ method: 'PUT', url: '/merchant/daily-confirmation',
    headers: headers(id), payload: { enabled, expectedVersion, reason: 'owner choice', ...extra } });
  const schedule = (payload: object, expectedVersion: number | undefined = 0, id: string = seedIds.admin, extra = {}) => app.inject({ method: 'PUT',
    url: `/admin/business-configs/${key}`, headers: headers(id), payload: { payload, expectedVersion, reason: 'safe transition', ...extra } });

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
});
