import { MerchantExposureState, type PrismaClient } from '@prisma/client';
import { Type } from '@sinclair/typebox';
import type { FastifyInstance } from 'fastify';
import type { AppConfig } from '../config.js';
import { actorOf, authGuard } from '../auth/auth.js';
import { loadPolicyConfig } from '../merchant-policy/policies.js';
import { notFound } from '../shared/errors.js';
import { getMerchantRiskSummary } from '../merchant-risk/service.js';
import { isMerchantVisibleToCustomer } from './visibility.js';

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

  app.get('/merchants', { preHandler: authenticate, schema: { tags: ['catalog'] } }, async (request) => {
    const actor = actorOf(request);
    const { config: policy } = await loadPolicyConfig(prisma);
    const merchants = await prisma.merchant.findMany({
      where: { exposureState: { notIn: [MerchantExposureState.HIDDEN, MerchantExposureState.SUSPENDED] } },
      select: {
        id: true,
        name: true,
        description: true,
        isOpen: true,
        exposureState: true,
        trialExposureOverrideBps: true,
        supportedDeliveryMethods: true,
        campusLocation: { select: { id: true, name: true, type: true } },
      },
      orderBy: { createdAt: 'asc' },
    });
    const visible = merchants.filter((merchant) => actor.role !== 'CUSTOMER' || isMerchantVisibleToCustomer({
      merchantId: merchant.id,
      customerId: actor.id,
      exposureState: merchant.exposureState,
      trialExposureOverrideBps: merchant.trialExposureOverrideBps,
      configuredTrialExposureBps: policy.merchantTrialExposureBps,
    }));
    return Promise.all(visible.map(async (merchant) => {
      const risk = await getMerchantRiskSummary(prisma, merchant.id);
      return {
        id: merchant.id,
        name: merchant.name,
        description: merchant.description,
        isOpen: merchant.isOpen,
        supportedDeliveryMethods: merchant.supportedDeliveryMethods,
        campusLocation: merchant.campusLocation,
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
    const actor = actorOf(request);
    const { config: policy } = await loadPolicyConfig(prisma);
    const merchant = await prisma.merchant.findUnique({
      where: { id: request.params.merchantId },
      select: {
        id: true,
        name: true,
        description: true,
        isOpen: true,
        exposureState: true,
        trialExposureOverrideBps: true,
        supportedDeliveryMethods: true,
        campusLocation: { select: { id: true, name: true, type: true } },
        categories: {
          select: {
            id: true,
            name: true,
            sortOrder: true,
            products: {
              where: { isAvailable: true },
              orderBy: { createdAt: 'asc' },
              select: { id: true, name: true, description: true, priceMinor: true },
            },
          },
          orderBy: { sortOrder: 'asc' },
        },
      },
    });
    if (!merchant) throw notFound('Merchant');
    if (actor.role === 'CUSTOMER' && !isMerchantVisibleToCustomer({
      merchantId: merchant.id,
      customerId: actor.id,
      exposureState: merchant.exposureState,
      trialExposureOverrideBps: merchant.trialExposureOverrideBps,
      configuredTrialExposureBps: policy.merchantTrialExposureBps,
    })) throw notFound('Merchant');
    const risk = await getMerchantRiskSummary(prisma, merchant.id);
    return {
      id: merchant.id,
      name: merchant.name,
      description: merchant.description,
      isOpen: merchant.isOpen,
      supportedDeliveryMethods: merchant.supportedDeliveryMethods,
      campusLocation: merchant.campusLocation,
      categories: merchant.categories,
      risk: {
        timeRisk: risk.timeRisk,
        completionRisk: risk.completionRisk,
        sampleStatus: risk.sampleStatus,
      },
    };
  });
}

