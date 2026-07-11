import { resolveAppEnv } from '@/lib/app-env';

type WebSentryEnv = Partial<
  Pick<
    NodeJS.ProcessEnv,
    | 'GITHUB_SHA'
    | 'R_APP_ENV'
    | 'NEXT_PUBLIC_SENTRY_RELEASE'
    | 'NODE_ENV'
    | 'VERCEL_GIT_COMMIT_SHA'
    | 'VERCEL_DEPLOYMENT_ID'
    | 'RELEASE_VERSION'
  >
>;

export function isWebSentryEnabled(
  env: Pick<NodeJS.ProcessEnv, 'NODE_ENV'> = process.env,
): boolean {
  return env.NODE_ENV !== 'development';
}

export function resolveWebSentryEnvironment(
  env: WebSentryEnv = process.env,
): string {
  return resolveAppEnv(
    env as NodeJS.ProcessEnv,
    env.NODE_ENV === 'development' ? 'development' : 'production',
  );
}

export function resolveWebSentryRelease(
  env: WebSentryEnv = process.env,
): string | undefined {
  return (
    env.NEXT_PUBLIC_SENTRY_RELEASE?.trim() ||
    env.VERCEL_GIT_COMMIT_SHA?.trim() ||
    env.GITHUB_SHA?.trim() ||
    env.VERCEL_DEPLOYMENT_ID?.trim() ||
    env.RELEASE_VERSION?.trim() ||
    undefined
  );
}
