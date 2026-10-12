import 'dotenv/config';

export type AppConfig = {
  databaseUrl: string;
  host: string;
  port: number;
  enableDevAuth: boolean;
  enableBackgroundJobs: boolean;
  backgroundSweepIntervalMs: number;
  campusTimeZone: string;
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

function positiveIntegerEnv(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}

export function loadConfig(): AppConfig {
  const port = positiveIntegerEnv('PORT', 3000);
  if (port > 65535) throw new Error('PORT must be no greater than 65535');

  const enableDevAuth = booleanEnv('ENABLE_DEV_AUTH', false);
  if (process.env.NODE_ENV === 'production' && enableDevAuth) {
    throw new Error('ENABLE_DEV_AUTH cannot be enabled in production');
  }

  return {
    databaseUrl: required('DATABASE_URL'),
    host: process.env.HOST ?? '0.0.0.0',
    port,
    enableDevAuth,
    enableBackgroundJobs: booleanEnv('ENABLE_BACKGROUND_JOBS', false),
    backgroundSweepIntervalMs: positiveIntegerEnv('BACKGROUND_SWEEP_INTERVAL_MS', 5000),
    campusTimeZone: process.env.CAMPUS_TIME_ZONE ?? 'Asia/Shanghai',
    logLevel: process.env.LOG_LEVEL ?? 'info',
  };
}
