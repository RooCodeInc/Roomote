import { DOCS_BASE_URL } from './docs';

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

export function getDefaultDocsUrl(
  _appEnv: AppEnv,
  _currentUrl = 'http://localhost:3000',
): string {
  return DOCS_BASE_URL;
}
