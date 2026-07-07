import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z
    .enum(['development', 'production', 'test'])
    .default('development'),
  PORT: z.string().default('8081'),
  ROOMOTE_APP_URL: z.string().default('http://localhost:13000'),
  JOB_AUTH_PUBLIC_KEY: z.string().optional(),
  PREVIEW_TOKEN_TTL_SECONDS: z.string().default('3600'),
  DATABASE_URL: z
    .string()
    .default(
      'postgres://postgres:password@localhost:15432/roomote_development',
    ),
  // Note: REDIS_URL is required and validated via @roomote/env
  SENTRY_DSN: z.string().optional(),
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace'])
    .optional(),
  /**
   * When set, operate in "inner" mode for nested preview-proxy support.
   * The suffix is stripped from incoming hostnames before parsing.
   * Format: `{outerTaskId}-{outerPortSlug}` (e.g., `20imtw24sm6hv-preview`)
   */
  PREVIEW_PROXY_SUBDOMAIN_SUFFIX: z.string().optional(),
  /**
   * Cookie name for preview auth. Default: 'preview_auth'.
   * Inner preview-proxies use a different name to avoid conflicts with outer proxy.
   */
  PREVIEW_AUTH_COOKIE_NAME: z.string().default('preview_auth'),
});

function getConfig(): z.infer<typeof envSchema> {
  const result = envSchema.safeParse(process.env);

  if (!result.success) {
    console.error('Invalid environment variables:', result.error.format());
    throw new Error('Invalid environment configuration');
  }

  if (
    result.data.NODE_ENV === 'production' &&
    !process.env.ROOMOTE_APP_URL?.trim()
  ) {
    throw new Error(
      'ROOMOTE_APP_URL must be configured explicitly in production',
    );
  }

  if (
    result.data.NODE_ENV === 'production' &&
    !process.env.DATABASE_URL?.trim()
  ) {
    throw new Error('DATABASE_URL must be configured explicitly in production');
  }

  return result.data;
}

export const config = getConfig();
