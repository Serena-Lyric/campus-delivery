import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import type { PrismaClient } from '@prisma/client';
import Fastify from 'fastify';
import type { AppConfig } from './config.js';
import { registerCatalogRoutes } from './catalog/routes.js';
import { registerDeliveryRoutes } from './delivery/routes.js';
import { registerOrderRoutes } from './orders/routes.js';
import { installErrorHandler } from './shared/errors.js';

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
        description: 'Phase-one API for a campus delivery order pool',
        version: '0.1.0',
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

  app.get('/health', { schema: { tags: ['system'], security: [] } }, async () => ({ status: 'ok' }));
  await registerCatalogRoutes(app, prisma, config);
  await registerOrderRoutes(app, prisma, config);
  await registerDeliveryRoutes(app, prisma, config);

  return app;
}
