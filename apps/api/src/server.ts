import { loadConfig } from './config.js';
import { createPrismaClient } from './prisma.js';
import { buildApp } from './app.js';

const config = loadConfig();
const prisma = createPrismaClient();
const app = await buildApp(config, prisma);

const shutdown = async () => {
  await app.close();
  await prisma.$disconnect();
};

process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);

try {
  await app.listen({ host: config.host, port: config.port });
} catch (error) {
  app.log.error(error);
  await prisma.$disconnect();
  process.exitCode = 1;
}
