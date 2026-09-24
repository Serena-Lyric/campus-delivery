import { MerchantExposureState, type PrismaClient } from '@prisma/client';
import { Type } from '@sinclair/typebox';
import type { FastifyInstance } from 'fastify';
import { actorOf, authGuard } from '../auth/auth.js';
import type { AppConfig } from '../config.js';
import { forbidden, notFound } from '../shared/errors.js';
import { evaluateMerchantExposure, getMerchantRiskSummary } from './service.js';

const MerchantIdParams = Type.Object({ merchantId: Type.String({ format: 'uuid' }) });

export async function registerMerchantRiskRoutes(app: FastifyInstance, prisma: PrismaClient, config: AppConfig) {
  const merchant = authGuard(prisma, config, ['MERCHANT']);
  const admin = authGuard(prisma, config, ['ADMIN']);

  app.get('/merchant/fulfillment-risk', {
    preHandler: merchant,
    schema: { tags: ['merchant-risk'] },
  }, async (request) => {
    const actor = actorOf(request);
    if (!actor.merchantId) throw forbidden();
    const summary = await getMerchantRiskSummary(prisma, actor.merchantId);
    return {
      sampleStatus: summary.sampleStatus,
      timeRisk: summary.timeRisk,
      completionRisk: summary.completionRisk,
      metrics: {
        publishedOrderCount: summary.metrics.publishedOrderCount,
        observableTerminalOrderCount: summary.metrics.observableTerminalOrderCount,
        deliveredOrderCount: summary.metrics.deliveredOrderCount,
        noRiderAcceptedCount: summary.metrics.noRiderAcceptedCount,
        observableCompletionRateBps: summary.metrics.observableCompletionRateBps,
        averageClaimLatencySeconds: summary.metrics.averageClaimLatencySeconds,
        claimLatencyP50Seconds: summary.metrics.claimLatencyP50Seconds,
        claimLatencyP90Seconds: summary.metrics.claimLatencyP90Seconds,
        averageClaimToPickupSeconds: summary.metrics.averageClaimToPickupSeconds,
        averagePickupToDeliverySeconds: summary.metrics.averagePickupToDeliverySeconds,
        averageTotalFulfillmentSeconds: summary.metrics.averageTotalFulfillmentSeconds,
        exceptionCounts: summary.metrics.exceptionCounts,
      },
    };
  });

  app.get<{ Params: { merchantId: string } }>('/admin/merchants/:merchantId/fulfillment-risk', {
    preHandler: admin,
    schema: { tags: ['merchant-risk'], params: MerchantIdParams },
  }, async (request) => {
    const merchantRecord = await prisma.merchant.findUnique({
      where: { id: request.params.merchantId },
      include: {
        subsidyAccount: true,
        exposureDecisions: { orderBy: { createdAt: 'desc' }, take: 100 },
      },
    });
    if (!merchantRecord) throw notFound('Merchant');
    return {
      merchant: merchantRecord,
      risk: await getMerchantRiskSummary(prisma, request.params.merchantId),
    };
  });

  app.post<{
    Params: { merchantId: string };
    Body: { forcedState?: MerchantExposureState };
  }>('/admin/merchants/:merchantId/exposure/evaluate', {
    preHandler: admin,
    schema: {
      tags: ['merchant-risk'],
      params: MerchantIdParams,
      body: Type.Object({ forcedState: Type.Optional(Type.Enum(MerchantExposureState)) }),
    },
  }, async (request) => evaluateMerchantExposure(
    prisma,
    actorOf(request),
    request.params.merchantId,
    request.body.forcedState,
  ));
}
