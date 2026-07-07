import { isLoopbackHostname } from '@roomote/types';

import { captureWorkerException } from '../../monitoring/sentry';

type PollingLogLevel = 'warn' | 'error';

type PollingLogger = Pick<Console, PollingLogLevel>;

interface PollingTransportContextOptions {
  stage: string;
  cloudJobId: number;
  sessionId: string;
  sdkMethod: string;
  failurePoint?: string;
  env?: NodeJS.ProcessEnv;
}

interface LogPollingTransportErrorOptions extends PollingTransportContextOptions {
  logger: PollingLogger;
  error: unknown;
  message: string;
  level?: PollingLogLevel;
}

interface RunPollingSdkCallOptions<T> extends PollingTransportContextOptions {
  execute: () => Promise<T>;
  logger: PollingLogger;
  message: string;
  level?: PollingLogLevel;
}

function buildPollingTransportErrorContext({
  stage,
  cloudJobId,
  sessionId,
  sdkMethod,
  failurePoint,
  env = process.env,
}: PollingTransportContextOptions): Record<
  string,
  string | number | boolean | null
> {
  const trpcUrl = env.TRPC_URL?.trim() || null;

  try {
    const parsedTrpcUrl = trpcUrl ? new URL(trpcUrl) : null;

    return {
      stage,
      cloudJobId,
      harnessSessionId: sessionId,
      sdkMethod,
      ...(failurePoint ? { failurePoint } : {}),
      trpcUrlOrigin: parsedTrpcUrl?.origin ?? trpcUrl,
      trpcHostname: parsedTrpcUrl?.hostname ?? null,
      isLoopbackTrpcUrl: parsedTrpcUrl
        ? isLoopbackHostname(parsedTrpcUrl.hostname)
        : false,
      hasAuthToken: Boolean(env.AUTH_TOKEN?.trim()),
      hasBypassHeader: Boolean(env.ROOMOTE_AUTH_BYPASS_VALUE?.trim()),
    };
  } catch {
    return {
      stage,
      cloudJobId,
      harnessSessionId: sessionId,
      sdkMethod,
      ...(failurePoint ? { failurePoint } : {}),
      trpcUrlOrigin: trpcUrl,
      trpcHostname: null,
      isLoopbackTrpcUrl: false,
      hasAuthToken: Boolean(env.AUTH_TOKEN?.trim()),
      hasBypassHeader: Boolean(env.ROOMOTE_AUTH_BYPASS_VALUE?.trim()),
    };
  }
}

export function logPollingTransportError({
  logger,
  error,
  message,
  level = 'error',
  ...contextOptions
}: LogPollingTransportErrorOptions): void {
  const errorContext = buildPollingTransportErrorContext(contextOptions);

  captureWorkerException(error, errorContext);
  logger[level](message, error, errorContext);
}

export async function runPollingSdkCall<T>({
  execute,
  logger,
  message,
  level = 'error',
  ...contextOptions
}: RunPollingSdkCallOptions<T>): Promise<T | undefined> {
  try {
    return await execute();
  } catch (error) {
    logPollingTransportError({
      logger,
      error,
      message,
      level,
      ...contextOptions,
    });

    return undefined;
  }
}
