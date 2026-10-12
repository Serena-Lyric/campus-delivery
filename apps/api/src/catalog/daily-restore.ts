import type { PrismaClient, ProductSaleStatus } from '@prisma/client';
import type { AppConfig } from '../config.js';
import { campusDay, campusMinuteOfDay } from '../shared/time.js';
import { dailyRestoreConfigLock, loadDailyRestoreConfig } from './daily-restore-config.js';

export async function restoreDailyProducts(prisma: PrismaClient,
  config: Pick<AppConfig, 'enableBackgroundJobs' | 'campusTimeZone'>, clock: () => Date = () => new Date()): Promise<number> {
  if (!config.enableBackgroundJobs) return 0;
  const candidates = await prisma.merchant.findMany({ where: { dailyProductRestoreEnabled: true }, select: { id: true }, orderBy: { id: 'asc' } });
  let restored = 0;
  for (const { id } of candidates) {
    restored += await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock_shared(${dailyRestoreConfigLock})`;
      const schedule = await loadDailyRestoreConfig(tx, config.campusTimeZone);
      // Same order as checkout and manual catalog operations: config -> merchant -> products.
      await tx.$queryRaw`SELECT "id" FROM "Merchant" WHERE "id"=${id}::uuid FOR UPDATE`;
      const merchant = await tx.merchant.findUnique({ where: { id }, select: { dailyProductRestoreEnabled: true, dailyProductRestoreVersion: true } });
      if (!merchant?.dailyProductRestoreEnabled) return 0;
      // Read actual execution time after lock waits, never replay a captured past date.
      const now = clock();
      const [hour, minute] = schedule.time.split(':').map(Number);
      if (campusMinuteOfDay(now, schedule.timeZone) < hour! * 60 + minute!) return 0;
      const day = campusDay(now, schedule.timeZone);
      const latest = await tx.merchantDailyRestoreRun.findFirst({ where: { merchantId: id }, orderBy: { day: 'desc' }, select: { day: true } });
      // Durable monotonic cursor also prevents historical backfill after clock/time-zone rollback.
      if (latest && day.getTime() <= latest.day.getTime()) return 0;
      // Lock every existing row in stable order; legacy boolean writers also take these row locks.
      // The returned rows form the batch, excluding products concurrently inserted by old writers.
      const products = await tx.$queryRaw<Array<{ id: string; version: number; saleStatus: ProductSaleStatus }>>`
        SELECT "id", "version", "saleStatus" FROM "Product" WHERE "merchantId"=${id}::uuid ORDER BY "id" FOR UPDATE`;
      // Crossing midnight or a clock rollback while waiting must not backfill an old date.
      const triggeredAt = clock();
      if (campusDay(triggeredAt, schedule.timeZone).getTime() !== day.getTime()
        || campusMinuteOfDay(triggeredAt, schedule.timeZone) < hour! * 60 + minute!) return 0;
      const sold = products.filter((p) => p.saleStatus === 'SOLD_OUT');
      const run = await tx.merchantDailyRestoreRun.create({ data: { merchantId: id, day, timeZone: schedule.timeZone,
        scheduledTime: schedule.time, configVersion: schedule.version, preferenceVersion: merchant.dailyProductRestoreVersion,
        triggeredAt, restoredCount: sold.length } });
      for (const product of sold) {
        const changed = await tx.product.updateMany({ where: { id: product.id, merchantId: id, version: product.version, saleStatus: 'SOLD_OUT' },
          data: { saleStatus: 'ON_SALE', version: { increment: 1 } } });
        if (changed.count !== 1) throw new Error('Daily restore product version changed; retry the whole batch');
        await tx.productDailyRestoreAudit.create({ data: { runId: run.id, productId: product.id, version: product.version + 1,
          previousStatus: 'SOLD_OUT', newStatus: 'ON_SALE' } });
      }
      return sold.length;
    });
  }
  return restored;
}
