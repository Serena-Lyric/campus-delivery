import { MerchantExposureState, type PrismaClient } from '@prisma/client';
import { Type } from '@sinclair/typebox';
import type { FastifyInstance } from 'fastify';
import type { AppConfig } from '../config.js';
import { actorOf, authGuard } from '../auth/auth.js';
import { loadPolicyConfig } from '../merchant-policy/policies.js';
import { forbidden, notFound } from '../shared/errors.js';
import { getMerchantRiskSummary } from '../merchant-risk/service.js';
import { CategoryBody, ProductBody, productSelect, deliveryCategorySelect, saveCategory, saveProduct, type CategoryInput, type ProductInput } from './service.js';
import { correctCatalogRisk, getCatalogRiskForMerchant, republishCorrectedOrder } from './risk-correction.js';
import { isMerchantVisibleToCustomer } from './visibility.js';

const IdParams = Type.Object({ merchantId: Type.String({ format: 'uuid' }) });

export async function registerCatalogRoutes(app: FastifyInstance, prisma: PrismaClient, config: AppConfig) {
  const authenticate = authGuard(prisma, config);

  const merchantOnly = authGuard(prisma, config, ['MERCHANT']);
  app.get('/catalog/delivery-categories', { preHandler: authenticate, schema: { tags: ['catalog'] } }, async () =>
    prisma.deliveryCategory.findMany({ select: deliveryCategorySelect, orderBy: { code: 'asc' } }));
  app.get('/merchant/catalog', { preHandler: merchantOnly, schema: { tags: ['catalog'] } }, async (request) => {
    const actor = actorOf(request);
    if (!actor.merchantId) throw forbidden();
    return prisma.productCategory.findMany({
      where: { merchantId: actor.merchantId },
      select: { id: true, name: true, sortOrder: true, products: { select: productSelect, orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }] } },
      orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
    });
  });
  app.post<{ Body: CategoryInput }>('/merchant/catalog/categories', {
    preHandler: merchantOnly, schema: { tags: ['catalog'], body: CategoryBody },
  }, async (request, reply) => reply.status(201).send(await saveCategory(prisma, actorOf(request), request.body)));
  app.put<{ Params: { id: string }; Body: CategoryInput }>('/merchant/catalog/categories/:id', {
    preHandler: merchantOnly, schema: { tags: ['catalog'], params: Type.Object({ id: Type.String({ format: 'uuid' }) }), body: CategoryBody },
  }, async (request) => saveCategory(prisma, actorOf(request), request.body, request.params.id));
  app.post<{ Body: ProductInput }>('/merchant/catalog/products', {
    preHandler: merchantOnly, schema: { tags: ['catalog'], body: ProductBody },
  }, async (request, reply) => reply.status(201).send(await saveProduct(prisma, actorOf(request), request.body)));
  app.put<{ Params: { id: string }; Body: ProductInput & { expectedVersion: number } }>('/merchant/catalog/products/:id', {
    preHandler: merchantOnly,
    schema: { tags: ['catalog'], params: Type.Object({ id: Type.String({ format: 'uuid' }) }),
      body: Type.Object({ ...ProductBody.properties, expectedVersion: Type.Integer({ minimum: 1 }) }, { additionalProperties: false }) },
  }, async (request) => {
    const { expectedVersion, ...input } = request.body;
    return saveProduct(prisma, actorOf(request), input, request.params.id, expectedVersion);
  });

  const OrderParams = Type.Object({ orderId: Type.String({ format: 'uuid' }) });
  const ReportRevision = { reportId: Type.String({ format: 'uuid' }), expectedRevision: Type.Integer({ minimum: 0 }) };
  app.get<{ Params: { orderId: string } }>('/merchant/orders/:orderId/catalog-risk', {
    preHandler: merchantOnly, schema: { tags: ['catalog'], params: OrderParams },
  }, async (request) => getCatalogRiskForMerchant(prisma, actorOf(request), request.params.orderId));
  app.post<{ Params: { orderId: string }; Body: { reportId: string; expectedRevision: number; deliveryCategoryCode: string } }>('/merchant/orders/:orderId/correct-catalog-risk', {
    preHandler: merchantOnly, schema: { tags: ['catalog'], params: OrderParams,
      body: Type.Object({ ...ReportRevision, deliveryCategoryCode: Type.Union([Type.Literal('CAKE'), Type.Literal('SUNDAE')]) }, { additionalProperties: false }) },
  }, async (request) => correctCatalogRisk(prisma, actorOf(request), request.params.orderId, request.body));
  app.post<{ Params: { orderId: string }; Body: { reportId: string; expectedRevision: number } }>('/merchant/orders/:orderId/republish-corrected', {
    preHandler: merchantOnly, schema: { tags: ['catalog'], params: OrderParams, body: Type.Object(ReportRevision, { additionalProperties: false }) },
  }, async (request) => republishCorrectedOrder(prisma, actorOf(request), request.params.orderId, request.body));

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
              orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
              select: productSelect,
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

