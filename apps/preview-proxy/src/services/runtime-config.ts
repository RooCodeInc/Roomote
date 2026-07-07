import { resolveEffectivePreviewRuntimeConfig } from '@roomote/db/server';

const CACHE_TTL_MS = 5_000;

let cachedConfig: Awaited<
  ReturnType<typeof resolveEffectivePreviewRuntimeConfig>
> | null = null;
let cacheExpiresAt = 0;

export async function getCachedPreviewRuntimeConfig() {
  const now = Date.now();

  if (cachedConfig && now < cacheExpiresAt) {
    return cachedConfig;
  }

  cachedConfig = await resolveEffectivePreviewRuntimeConfig({
    runtimeEnv: process.env,
  });
  cacheExpiresAt = now + CACHE_TTL_MS;

  return cachedConfig;
}
