import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import type { PrismaClient } from '@prisma/client';
import Fastify from 'fastify';
import { startLifecycleProcessor } from './background.js';
import { registerCatalogRoutes } from './catalog/routes.js';
import type { AppConfig } from './config.js';
import { registerDeliveryRoutes } from './delivery/routes.js';
import { registerEvidenceRoutes } from './evidence/routes.js';
import { MockMediaStorage } from './evidence/media-storage.js';
import { registerExceptionRoutes } from './exceptions/routes.js';
import { registerOrderRoutes } from './orders/routes.js';
import { registerSettlementRoutes } from './settlements/routes.js';
import { installErrorHandler } from './shared/errors.js';
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
        description: 'Campus order lifecycle, handoff evidence, delivery pool, and pending settlement API',
        version: '0.2.0',
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
  await registerDeliveryRoutes(app, prisma, config);
  await registerEvidenceRoutes(app, prisma, config, mediaStorage);
  await registerExceptionRoutes(app, prisma, config);
  await registerVerificationRoutes(app, prisma, config);
  await registerTimelineRoutes(app, prisma, config);
  await registerSettlementRoutes(app, prisma, config);

  const stopLifecycleProcessor = startLifecycleProcessor(prisma, config, app.log);
  app.addHook('onClose', async () => stopLifecycleProcessor());

  return app;
}
