import * as Sentry from '@sentry/nextjs';
import { TRPCError } from '@trpc/server';

import {
  getDatabaseErrorDiagnostics,
  getDatabaseReachabilityDiagnostics,
  getDatabaseRuntimeDiagnostics,
} from '@roomote/db/server';

import { getWebRuntimeEnvDiagnostics } from '@/lib/server/env';
import { logger } from '@/lib/server/logger';
import {
  buildNestedTrpcClientErrorDetails,
  type NestedTrpcClientErrorDetails,
} from './trpc-client-error-parsing';

export function shouldReportTrpcProcedureError(error: unknown): boolean {
  return !(
    error instanceof TRPCError && error.code !== 'INTERNAL_SERVER_ERROR'
  );
}

type SanitizedDatabaseTarget =
  | 'missing'
  | 'invalid'
  | 'localhost'
  | 'remote'
  | 'unknown';

type SanitizedReachabilityStatus =
  | 'reachable'
  | 'unreachable'
  | 'missing'
  | 'invalid'
  | 'unknown';

type TrpcClientErrorDetails = {
  message: string;
  diagnostics?: {
    runtimeBootstrapCompleted: boolean;
    dbClientInitialized: boolean;
    urlsMatch: boolean | null;
    configuredTarget: SanitizedDatabaseTarget;
    configuredReachability: SanitizedReachabilityStatus;
    configuredReachabilityErrorCode: string | number | null;
    processEnvTarget: SanitizedDatabaseTarget;
    processEnvReachability: SanitizedReachabilityStatus;
    processEnvReachabilityErrorCode: string | number | null;
    causeCode: string | number | null;
    causeTarget: SanitizedDatabaseTarget;
    causePort: string | number | null;
  };
  nestedTrpc?: NestedTrpcClientErrorDetails['nestedTrpc'];
};

const TRPC_CLIENT_ERROR_DETAILS_SYMBOL = Symbol.for(
  'roomote.trpcClientErrorDetails',
);

function attachTrpcClientErrorDetails(
  error: unknown,
  details: TrpcClientErrorDetails,
) {
  if (!(error instanceof Error)) {
    return;
  }

  Object.defineProperty(error, TRPC_CLIENT_ERROR_DETAILS_SYMBOL, {
    value: details,
    enumerable: false,
    configurable: true,
    writable: true,
  });
}

function getAttachedTrpcClientErrorDetails(
  error: unknown,
): TrpcClientErrorDetails | null {
  if (!(error instanceof Error)) {
    return null;
  }

  return (
    (
      error as Error & {
        [TRPC_CLIENT_ERROR_DETAILS_SYMBOL]?: TrpcClientErrorDetails;
      }
    )[TRPC_CLIENT_ERROR_DETAILS_SYMBOL] ?? null
  );
}

function attachTrpcClientErrorDetailsToErrorChain(
  error: unknown,
  details: TrpcClientErrorDetails,
) {
  attachTrpcClientErrorDetails(error, details);

  const cause =
    error instanceof Error && error.cause instanceof Error ? error.cause : null;

  if (cause) {
    attachTrpcClientErrorDetails(cause, details);
  }
}

function isLocalDatabaseHost(host: string | null | undefined): boolean {
  if (!host) {
    return false;
  }

  return ['localhost', '127.0.0.1', '::1'].includes(host);
}

function sanitizeDatabaseTarget(databaseUrl: {
  present: boolean;
  parsed: boolean;
  details: { hostname: string } | null;
}): SanitizedDatabaseTarget {
  if (!databaseUrl.present) {
    return 'missing';
  }

  if (!databaseUrl.parsed) {
    return 'invalid';
  }

  return isLocalDatabaseHost(databaseUrl.details?.hostname)
    ? 'localhost'
    : 'remote';
}

function sanitizeCauseTarget(
  error: ReturnType<typeof getDatabaseErrorDiagnostics>,
) {
  if (!error?.cause) {
    return 'unknown';
  }

  if (isLocalDatabaseHost(error.cause.hostname ?? error.cause.address)) {
    return 'localhost';
  }

  return error.cause.hostname || error.cause.address ? 'remote' : 'unknown';
}

function sanitizeReachabilityStatus(
  diagnostics:
    | Awaited<ReturnType<typeof getDatabaseReachabilityDiagnostics>>
    | null
    | undefined,
  target: 'configuredUrl' | 'processEnvUrl',
): SanitizedReachabilityStatus {
  return diagnostics?.[target].status ?? 'unknown';
}

function isDatabaseBootstrapError(error: unknown): error is Error {
  return (
    error instanceof Error &&
    error.message.includes('@roomote/db was accessed before')
  );
}

function buildTrpcClientErrorDetails(
  error: unknown,
  databaseReachabilityDiagnostics?: Awaited<
    ReturnType<typeof getDatabaseReachabilityDiagnostics>
  > | null,
): TrpcClientErrorDetails | null {
  const runtimeDiagnostics = getWebRuntimeEnvDiagnostics();
  const databaseRuntimeDiagnostics = getDatabaseRuntimeDiagnostics();
  const databaseDiagnostics = getDatabaseErrorDiagnostics(error);

  if (!databaseDiagnostics && !isDatabaseBootstrapError(error)) {
    return buildNestedTrpcClientErrorDetails(error);
  }

  return {
    message: isDatabaseBootstrapError(error)
      ? 'Database initialization ran before runtime bootstrap completed.'
      : 'Database query failed.',
    diagnostics: {
      runtimeBootstrapCompleted: runtimeDiagnostics.bootstrapCompleted,
      dbClientInitialized: databaseRuntimeDiagnostics.clientInitialized,
      urlsMatch:
        databaseReachabilityDiagnostics?.urlsMatch ??
        databaseRuntimeDiagnostics.urlsMatch,
      configuredTarget: sanitizeDatabaseTarget(
        databaseRuntimeDiagnostics.configuredUrl,
      ),
      configuredReachability: sanitizeReachabilityStatus(
        databaseReachabilityDiagnostics,
        'configuredUrl',
      ),
      configuredReachabilityErrorCode:
        databaseReachabilityDiagnostics?.configuredUrl.error?.code ?? null,
      processEnvTarget: sanitizeDatabaseTarget(
        databaseRuntimeDiagnostics.processEnvUrl,
      ),
      processEnvReachability: sanitizeReachabilityStatus(
        databaseReachabilityDiagnostics,
        'processEnvUrl',
      ),
      processEnvReachabilityErrorCode:
        databaseReachabilityDiagnostics?.processEnvUrl.error?.code ?? null,
      causeCode: databaseDiagnostics?.cause?.code ?? null,
      causeTarget: sanitizeCauseTarget(databaseDiagnostics),
      causePort: databaseDiagnostics?.cause?.port ?? null,
    },
  };
}

export async function enrichTrpcClientErrorDetails(error: unknown) {
  const baseDetails = buildTrpcClientErrorDetails(error);

  if (!baseDetails) {
    return null;
  }

  if (!baseDetails.diagnostics) {
    attachTrpcClientErrorDetailsToErrorChain(error, baseDetails);
    return baseDetails;
  }

  const databaseReachabilityDiagnostics =
    await getDatabaseReachabilityDiagnostics().catch(() => null);
  const details = buildTrpcClientErrorDetails(
    error,
    databaseReachabilityDiagnostics,
  );

  if (details) {
    attachTrpcClientErrorDetailsToErrorChain(error, details);
  }

  return details;
}

export function getTrpcClientErrorDetails(error: unknown) {
  return (
    getAttachedTrpcClientErrorDetails(error) ??
    buildTrpcClientErrorDetails(error)
  );
}

export function getReportableTrpcProcedureError(error: unknown): unknown {
  const clientErrorDetails = getTrpcClientErrorDetails(error);

  if (
    !(error instanceof Error) ||
    !clientErrorDetails?.nestedTrpc ||
    clientErrorDetails.message === error.message
  ) {
    return error;
  }

  const reportableError = new Error(clientErrorDetails.message, {
    cause: error,
  });
  reportableError.name = error.name;

  if (error.stack) {
    reportableError.stack = error.stack.replace(
      error.message,
      clientErrorDetails.message,
    );
  }

  attachTrpcClientErrorDetails(reportableError, clientErrorDetails);

  return reportableError;
}

export function reportTrpcProcedureError({
  error,
  path,
  type,
}: {
  error: unknown;
  path: string;
  type: 'query' | 'mutation' | 'subscription';
}) {
  const runtimeDiagnostics = getWebRuntimeEnvDiagnostics();
  const databaseRuntimeDiagnostics = getDatabaseRuntimeDiagnostics();
  const databaseDiagnostics = getDatabaseErrorDiagnostics(error);
  const clientErrorDetails = getTrpcClientErrorDetails(error);
  const reportableError = getReportableTrpcProcedureError(error);

  logger.error(
    {
      event: 'trpc_procedure_error',
      path,
      procedureType: type,
      runtimeDiagnostics,
      databaseRuntimeDiagnostics,
      databaseDiagnostics,
      clientErrorDetails,
      error,
    },
    'tRPC procedure failed',
  );

  Sentry.withScope((scope) => {
    scope.setTag('trpc.path', path);
    scope.setTag('trpc.type', type);
    scope.setContext('webRuntimeEnv', runtimeDiagnostics);
    scope.setContext('databaseRuntime', databaseRuntimeDiagnostics);

    if (error instanceof TRPCError) {
      scope.setTag('trpc.code', error.code);
    }

    if (databaseDiagnostics) {
      scope.setContext('databaseError', databaseDiagnostics);
    }

    if (clientErrorDetails) {
      scope.setContext('trpcClientErrorDetails', clientErrorDetails);
    }

    Sentry.captureException(reportableError);
  });
}
