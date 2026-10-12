import type { PrismaClient } from '@prisma/client';
import type { FastifyBaseLogger } from 'fastify';
import type { AppConfig } from './config.js';
import { expireUnclaimedDeliveryTasks, releaseExpiredCoolingOrders } from './orders/lifecycle.js';
import { releaseAvailableRiderSettlements } from './settlements/service.js';
import { restoreDailyProducts } from './catalog/daily-restore.js';
export { restoreDailyProducts } from './catalog/daily-restore.js';

export function startLifecycleProcessor(
  prisma: PrismaClient,
  config: AppConfig,
  logger: Pick<FastifyBaseLogger, 'error' | 'info'>,
): () => void {
  if (!config.enableBackgroundJobs) return () => undefined;

  let running = false;
  const run = async () => {
    if (running) return;
    running = true;
    try {
      const [orders, expiredTasks, settlements, restoredProducts] = await Promise.all([
        releaseExpiredCoolingOrders(prisma),
        expireUnclaimedDeliveryTasks(prisma),
        releaseAvailableRiderSettlements(prisma),
        restoreDailyProducts(prisma, config),
      ]);
      if (orders + expiredTasks + settlements + restoredProducts > 0) {
        logger.info({ orders, expiredTasks, settlements, restoredProducts }, 'lifecycle processor advanced records');
      }
    } catch (error) {
      logger.error({ err: error }, 'lifecycle processor failed');
    } finally {
      running = false;
    }
  };

  void run();
  const timer = setInterval(() => void run(), config.backgroundSweepIntervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
