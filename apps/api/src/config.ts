import 'dotenv/config';

export type AppConfig = {
  databaseUrl: string;
  host: string;
  port: number;
  enableDevAuth: boolean;
  logLevel: string;
};

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function booleanEnv(name: string, fallback: boolean): boolean {
  const value = process.env[name];
  if (value === undefined) return fallback;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new Error(`${name} must be true or false`);
}

export function loadConfig(): AppConfig {
  const port = Number(process.env.PORT ?? 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('PORT must be an integer between 1 and 65535');
  }

  const enableDevAuth = booleanEnv('ENABLE_DEV_AUTH', false);
  if (process.env.NODE_ENV === 'production' && enableDevAuth) {
    throw new Error('ENABLE_DEV_AUTH cannot be enabled in production');
  }

  return {
    databaseUrl: required('DATABASE_URL'),
    host: process.env.HOST ?? '0.0.0.0',
    port,
    enableDevAuth,
    logLevel: process.env.LOG_LEVEL ?? 'info',
  };
}

