import { PrismaClient } from '@prisma/client';
import assert from 'node:assert/strict';
import { buildApp } from '../src/app.js';
import { seedDatabase, seedIds } from '../prisma/seed.js';

// Intentionally limited to disposable validation databases: repeat Seed updates demo profiles.
const databaseUrl = process.env.DATABASE_URL!;
assert.match(new URL(databaseUrl).pathname, /^\/campus_round7_(old|empty|final_empty)$/);
const prisma = new PrismaClient();
const app = await buildApp({ databaseUrl, host: '127.0.0.1', port: 3000, enableDevAuth: true,
  enableBackgroundJobs: false, backgroundSweepIntervalMs: 5000, campusTimeZone: 'Asia/Shanghai', logLevel: 'silent' }, prisma);
const financialTables = ['Order', 'OrderItem', 'OrderPricing', 'OrderEvent', 'DeliveryTask', 'DeliveryAssignment',
  'Settlement', 'RiderSettlement', 'CompensationObligation', 'CompensationAllocation', 'ExceptionCase', 'ExceptionCaseAction',
  'ExceptionEvent', 'Evidence', 'BusinessConfig', 'BusinessConfigAudit', 'MerchantOperatingStatusAudit', 'ProductSaleStatusAudit'];
async function snapshot() {
  const values = await Promise.all(financialTables.map(async (table) => {
    const [value] = await prisma.$queryRawUnsafe<Array<{ rows: bigint; fingerprint: string }>>(
      `SELECT count(*) AS rows, md5(COALESCE(string_agg(to_jsonb(t)::text, E'\\n' ORDER BY to_jsonb(t)::text), '')) AS fingerprint FROM "${table}" t`);
    return [table, Number(value!.rows), value!.fingerprint];
  }));
  const sales = await prisma.product.findMany({ orderBy: { id: 'asc' }, select: { id: true, saleStatus: true, isAvailable: true, version: true } });
  const operations = await prisma.merchant.findMany({ orderBy: { id: 'asc' }, select: { id: true, isOpen: true, operatingVersion: true } });
  return { financialFacts: values, sales, operations };
}
try {
  await app.ready();
  const tea = await prisma.product.findUniqueOrThrow({ where: { id: seedIds.productTea } });
  if (new URL(databaseUrl).pathname.endsWith('_old')) {
    assert.equal(tea.saleStatus, 'OFF_SHELF');
    assert.equal(tea.isAvailable, false);
    const menu = await app.inject({ method: 'GET', url: `/merchants/${seedIds.merchant}/products`, headers: { 'x-user-id': seedIds.customer } });
    assert.equal(menu.statusCode, 200);
    assert.equal(menu.json().categories.flatMap((c: { products: Array<{ id: string }> }) => c.products).some((p: { id: string }) => p.id === tea.id), false);
  }
  const before = await snapshot();
  await seedDatabase(prisma);
  assert.deepEqual(await snapshot(), before);
  await seedDatabase(prisma);
  assert.deepEqual(await snapshot(), before);
  console.log(JSON.stringify({ database: new URL(databaseUrl).pathname, repeatedSeed: 2, preserved: before, historicalFalseStillHidden: tea.saleStatus === 'OFF_SHELF' }));
} finally { await app.close(); await prisma.$disconnect(); }
