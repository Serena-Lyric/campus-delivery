import { MerchantExposureState, type PrismaClient } from '@prisma/client';
import { Type } from '@sinclair/typebox';
import type { FastifyInstance } from 'fastify';
import type { AppConfig } from '../config.js';
import { authGuard } from '../auth/auth.js';
import { notFound } from '../shared/errors.js';
import { getMerchantRiskSummary } from '../merchant-risk/service.js';

const IdParams = Type.Object({ merchantId: Type.String({ format: 'uuid' }) });

export async function registerCatalogRoutes(app: FastifyInstance, prisma: PrismaClient, config: AppConfig) {
  const authenticate = authGuard(prisma, config);

  app.get('/campus-locations', { preHandler: authenticate, schema: { tags: ['catalog'] } }, async () => {
    return prisma.campusLocation.findMany({
      select: {
        id: true,
        name: true,
        type: true,
        description: true,
        supportedDeliveryMethods: true,
      },
      orderBy: { name: 'asc' },
    });
  });

  app.get('/merchants', { preHandler: authenticate, schema: { tags: ['catalog'] } }, async () => {
    const merchants = await prisma.merchant.findMany({
      where: { exposureState: { notIn: [MerchantExposureState.HIDDEN, MerchantExposureState.SUSPENDED] } },
      select: {
        id: true,
        name: true,
        description: true,
        isOpen: true,
        exposureState: true,
        supportedDeliveryMethods: true,
        campusLocation: { select: { id: true, name: true, type: true } },
      },
      orderBy: { createdAt: 'asc' },
    });
    return Promise.all(merchants.map(async (merchant) => {
      const risk = await getMerchantRiskSummary(prisma, merchant.id);
      return {
        ...merchant,
        risk: {
          timeRisk: risk.timeRisk,
          completionRisk: risk.completionRisk,
          sampleStatus: risk.sampleStatus,
        },
      };
    }));
  });

  app.get<{ Params: { merchantId: string } }>('/merchants/:merchantId/products', {
    preHandler: authenticate,
    schema: { tags: ['catalog'], params: IdParams },
  }, async (request) => {
    const merchant = await prisma.merchant.findUnique({
      where: { id: request.params.merchantId },
      include: {
        categories: {
          orderBy: { sortOrder: 'asc' },
          include: { products: { where: { isAvailable: true }, orderBy: { createdAt: 'asc' } } },
        },
      },
    });
    if (!merchant) throw notFound('Merchant');
    const risk = await getMerchantRiskSummary(prisma, merchant.id);
    return {
      ...merchant,
      risk: {
        timeRisk: risk.timeRisk,
        completionRisk: risk.completionRisk,
        sampleStatus: risk.sampleStatus,
      },
    };
  });
}

