const {
  getDatabaseErrorDiagnosticsMock,
  getDatabaseReachabilityDiagnosticsMock,
  getDatabaseRuntimeDiagnosticsMock,
  getWebRuntimeEnvDiagnosticsMock,
} = vi.hoisted(() => ({
  getDatabaseErrorDiagnosticsMock: vi.fn(),
  getDatabaseReachabilityDiagnosticsMock: vi.fn(),
  getDatabaseRuntimeDiagnosticsMock: vi.fn(),
  getWebRuntimeEnvDiagnosticsMock: vi.fn(),
}));

vi.mock('@roomote/db/server', () => ({
  getDatabaseErrorDiagnostics: (...args: unknown[]) =>
    getDatabaseErrorDiagnosticsMock(...args),
  getDatabaseReachabilityDiagnostics: (...args: unknown[]) =>
    getDatabaseReachabilityDiagnosticsMock(...args),
  getDatabaseRuntimeDiagnostics: (...args: unknown[]) =>
    getDatabaseRuntimeDiagnosticsMock(...args),
}));

vi.mock('@/lib/server/env', () => ({
  getWebRuntimeEnvDiagnostics: (...args: unknown[]) =>
    getWebRuntimeEnvDiagnosticsMock(...args),
}));

describe('tRPC error payload diagnostics', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();

    getWebRuntimeEnvDiagnosticsMock.mockReturnValue({
      bootstrapCompleted: true,
    });
    getDatabaseRuntimeDiagnosticsMock.mockReturnValue({
      clientInitialized: true,
      urlsMatch: false,
      configuredUrl: {
        present: true,
        parsed: true,
        details: {
          hostname: 'configured.example.com',
          database: 'app_db',
        },
      },
      processEnvUrl: {
        present: true,
        parsed: true,
        details: {
          hostname: 'runtime.example.com',
          database: 'runtime_db',
        },
      },
    });
    getDatabaseReachabilityDiagnosticsMock.mockResolvedValue({
      urlsMatch: false,
      configuredUrl: {
        status: 'unreachable',
        error: {
          code: 'ECONNREFUSED',
        },
      },
      processEnvUrl: {
        status: 'reachable',
        error: null,
      },
    });
  });

  it('returns safe diagnostics for database query failures', async () => {
    const { enrichTrpcClientErrorDetails, getTrpcClientErrorDetails } =
      await import('../error-logging');

    getDatabaseRuntimeDiagnosticsMock.mockReturnValue({
      clientInitialized: true,
      urlsMatch: false,
      configuredUrl: {
        present: true,
        parsed: true,
        details: {
          hostname: '127.0.0.1',
          database: 'app_db',
        },
      },
      processEnvUrl: {
        present: true,
        parsed: true,
        details: {
          hostname: 'runtime.example.com',
          database: 'runtime_db',
        },
      },
    });

    getDatabaseErrorDiagnosticsMock.mockReturnValue({
      cause: {
        code: 'ECONNREFUSED',
        message: 'connect ECONNREFUSED 127.0.0.1:5432',
        hostname: '127.0.0.1',
        port: 5432,
      },
    });

    const error = new Error('Failed query');

    await enrichTrpcClientErrorDetails(error);

    expect(getTrpcClientErrorDetails(error)).toEqual({
      message: 'Database query failed.',
      diagnostics: {
        runtimeBootstrapCompleted: true,
        dbClientInitialized: true,
        urlsMatch: false,
        configuredTarget: 'localhost',
        configuredReachability: 'unreachable',
        configuredReachabilityErrorCode: 'ECONNREFUSED',
        processEnvTarget: 'remote',
        processEnvReachability: 'reachable',
        processEnvReachabilityErrorCode: null,
        causeCode: 'ECONNREFUSED',
        causeTarget: 'localhost',
        causePort: 5432,
      },
    });
  });

  it('returns a bootstrap-specific message for pre-bootstrap db initialization', async () => {
    const { enrichTrpcClientErrorDetails, getTrpcClientErrorDetails } =
      await import('../error-logging');

    getDatabaseErrorDiagnosticsMock.mockReturnValue(null);
    getDatabaseReachabilityDiagnosticsMock.mockResolvedValue({
      urlsMatch: null,
      configuredUrl: {
        status: 'missing',
        error: null,
      },
      processEnvUrl: {
        status: 'reachable',
        error: null,
      },
    });

    const error = new Error(
      '@roomote/db was accessed before apps/web finished bootstrapping',
    );

    await enrichTrpcClientErrorDetails(error);

    expect(getTrpcClientErrorDetails(error)).toEqual({
      message:
        'Database initialization ran before runtime bootstrap completed.',
      diagnostics: expect.objectContaining({
        runtimeBootstrapCompleted: true,
        dbClientInitialized: true,
        configuredReachability: 'missing',
        processEnvReachability: 'reachable',
      }),
    });
  });

  it('normalizes nested batched tRPC client errors for reporting', async () => {
    const {
      enrichTrpcClientErrorDetails,
      getReportableTrpcProcedureError,
      getTrpcClientErrorDetails,
    } = await import('../error-logging');

    getDatabaseErrorDiagnosticsMock.mockReturnValue(null);

    const error = new Error(
      '[{"error":{"message":"Task not found","code":-32603,"data":{"httpStatus":404,"path":"tasks.byId"}}}]',
    ) as Error & {
      meta?: {
        response?: { status: number };
        responseJSON?: unknown;
      };
    };
    error.name = 'TRPCClientError';
    error.meta = {
      response: { status: 404 },
      responseJSON: [
        {
          error: {
            message: 'Task not found',
            code: -32603,
            data: {
              httpStatus: 404,
              path: 'tasks.byId',
            },
          },
        },
      ],
    };

    await enrichTrpcClientErrorDetails(error);

    expect(getDatabaseReachabilityDiagnosticsMock).not.toHaveBeenCalled();
    expect(getTrpcClientErrorDetails(error)).toEqual({
      message: 'Task not found',
      nestedTrpc: {
        responseShape: 'batch',
        responseStatus: 404,
        errorCode: -32603,
        httpStatus: 404,
        path: 'tasks.byId',
      },
    });

    const reportableError = getReportableTrpcProcedureError(error) as Error;

    expect(reportableError).toBeInstanceOf(Error);
    expect(reportableError).not.toBe(error);
    expect(reportableError.name).toBe('TRPCClientError');
    expect(reportableError.message).toBe('Task not found');
    expect(reportableError.cause).toBe(error);
  });
});
