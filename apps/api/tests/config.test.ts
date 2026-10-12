import { afterEach, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config.js';

afterEach(() => vi.unstubAllEnvs());
it('keeps all background side effects disabled until explicitly enabled', () => {
  vi.stubEnv('DATABASE_URL', 'postgresql://campus:campus@localhost:5432/campus_round8_test');
  vi.stubEnv('ENABLE_DEV_AUTH', 'false');
  vi.stubEnv('ENABLE_BACKGROUND_JOBS', undefined);
  expect(loadConfig().enableBackgroundJobs).toBe(false);
  vi.stubEnv('ENABLE_BACKGROUND_JOBS', 'true');
  expect(loadConfig().enableBackgroundJobs).toBe(true);
  vi.stubEnv('ENABLE_BACKGROUND_JOBS', 'false');
  expect(loadConfig().enableBackgroundJobs).toBe(false);
});
