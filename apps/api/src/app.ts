import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import type { PrismaClient } from '@prisma/client';
import Fastify from 'fastify';
import { registerAdminConfigRoutes } from './admin/config-routes.js';
import { registerAdminProfileRoutes } from './admin/profile-routes.js';
import { startLifecycleProcessor } from './background.js';
import { registerCatalogRoutes } from './catalog/routes.js';
import type { AppConfig } from './config.js';
import { registerDeliveryRoutes } from './delivery/routes.js';
import { registerEvidenceRoutes } from './evidence/routes.js';
import { MockMediaStorage } from './evidence/media-storage.js';
import { registerExceptionRoutes } from './exceptions/routes.js';
import { registerExceptionCaseRoutes } from './exception-cases/routes.js';
import { registerMerchantRiskRoutes } from './merchant-risk/routes.js';
import { registerOrderRoutes } from './orders/routes.js';
import { registerMarketPricingRoutes } from './pricing/routes.js';
import { registerPricingViewRoutes } from './pricing/view-routes.js';
import { registerRiderRoutes } from './riders/routes.js';
import { registerEligibilityRoutes } from './riders/eligibility-routes.js';
import { registerSettlementRoutes } from './settlements/routes.js';
import { installErrorHandler } from './shared/errors.js';
import { registerSubsidyRoutes } from './subsidy/routes.js';
import { registerTimelineRoutes } from './timeline/routes.js';
import { registerVerificationRoutes } from './verification/routes.js';

export async function buildApp(config: AppConfig, prisma: PrismaClient) {
  const app = Fastify({
    logger: {
      level: config.logLevel,
      redact: ['req.headers.x-user-id'],
    },
  });
  app.decorateRequest('actor', null);
  installErrorHandler(app);

  await app.register(swagger, {
    openapi: {
      info: {
        title: 'campus-delivery API',
        description: 'Campus delivery market, rider capacity, order-pool facts, split delivery pricing, exceptions, and settlement API',
        version: '0.6.0',
      },
      components: {
        securitySchemes: {
          devUser: { type: 'apiKey', in: 'header', name: 'x-user-id' },
        },
      },
      security: [{ devUser: [] }],
    },
  });
  await app.register(swaggerUi, { routePrefix: '/docs' });

  const mediaStorage = new MockMediaStorage();
  app.get('/health', { schema: { tags: ['system'], security: [] } }, async () => ({ status: 'ok' }));
  await registerCatalogRoutes(app, prisma, config);
  await registerOrderRoutes(app, prisma, config);
  await registerMarketPricingRoutes(app, prisma, config);
  await registerPricingViewRoutes(app, prisma, config);
  await registerDeliveryRoutes(app, prisma, config);
  await registerRiderRoutes(app, prisma, config);
  await registerEligibilityRoutes(app, prisma, config);
  await registerSubsidyRoutes(app, prisma, config);
  await registerAdminConfigRoutes(app, prisma, config);
  await registerAdminProfileRoutes(app, prisma, config);
  await registerMerchantRiskRoutes(app, prisma, config);
  await registerEvidenceRoutes(app, prisma, config, mediaStorage);
  await registerExceptionRoutes(app, prisma, config);
  await registerExceptionCaseRoutes(app, prisma, config);
  await registerVerificationRoutes(app, prisma, config);
  await registerTimelineRoutes(app, prisma, config);
  await registerSettlementRoutes(app, prisma, config);

  const stopLifecycleProcessor = startLifecycleProcessor(prisma, config, app.log);
  app.addHook('onClose', async () => stopLifecycleProcessor());

  return app;
}
