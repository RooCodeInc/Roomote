export const APP_ENV_VALUES = ['development', 'preview', 'production'] as const;

export type AppEnv = (typeof APP_ENV_VALUES)[number];

function normalizeAppEnvCandidate(value: string | undefined): AppEnv | null {
  const normalized = value?.trim().toLowerCase();

  switch (normalized) {
    case 'development':
      return 'development';
    case 'preview':
      return 'preview';
    case 'production':
      return 'production';
    default:
      return null;
  }
}

export function resolveAppEnv(
  env: NodeJS.ProcessEnv = process.env,
  fallback: AppEnv = 'development',
): AppEnv {
  const candidates = [env.APP_ENV, env.ROOMOTE_APP_ENV];

  for (const candidate of candidates) {
    const normalized = normalizeAppEnvCandidate(candidate);

    if (normalized) {
      return normalized;
    }
  }

  return fallback;
}

export function getRootEnvFilePath(appEnv: AppEnv): string {
  return `.env.${appEnv}`;
}

export function getWebEnvFilePaths(_appEnv: AppEnv): readonly [string] {
  return ['../../.env.local'] as const;
}

export function getWebBundledEnvFilePaths(appEnv: AppEnv): readonly string[] {
  return [...getWebEnvFilePaths(appEnv)];
}

const DEFAULT_ALLOWED_DEV_ORIGINS = [
  'localhost',
  '127.0.0.1',
  '*.ngrok.dev',
  '*.ngrok.app',
  '*.ngrok-free.dev',
] as const;

export function getAllowedDevOrigins(
  previewDomainsRaw: string | undefined,
): readonly string[] {
  const previewDomains =
    previewDomainsRaw
      ?.split(',')
      .map((domain) => domain.trim())
      .filter(Boolean)
      .map((domain) => `*.${domain}`) ?? [];

  return [...new Set([...DEFAULT_ALLOWED_DEV_ORIGINS, ...previewDomains])];
}

export function getDefaultRoomoteAppUrl(appEnv: AppEnv): string {
  if (appEnv === 'development') {
    return 'http://localhost:13000';
  }

  throw new Error(
    `ROOMOTE_APP_URL must be configured explicitly for ${appEnv}`,
  );
}

export function getDefaultTrpcUrl(appEnv: AppEnv): string {
  if (appEnv === 'development') {
    return 'http://localhost:13001';
  }

  throw new Error(`TRPC_URL must be configured explicitly for ${appEnv}`);
}

export function getDefaultDocsUrl(
  _appEnv: AppEnv,
  _currentUrl = 'http://localhost:13000',
): string {
  return 'https://docs.roomote.dev';
}

export function getDefaultPreviewProxyBaseUrl(appEnv: AppEnv): string {
  if (appEnv === 'development') {
    return 'http://roomotepreview.localhost:18081';
  }

  throw new Error(
    `PREVIEW_PROXY_BASE_URL must be configured explicitly for ${appEnv}`,
  );
}
