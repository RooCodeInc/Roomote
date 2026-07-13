const {
  captureExceptionMock,
  defaultIntegrationsMock,
  captureMessageMock,
  flushMock,
  initMock,
  readFileSyncMock,
  setContextMock,
  setFingerprintMock,
  setLevelMock,
  setTagMock,
  withScopeMock,
} = vi.hoisted(() => {
  const setLevel = vi.fn();
  const setTag = vi.fn();
  const setContext = vi.fn();
  const setFingerprint = vi.fn();

  return {
    captureExceptionMock: vi.fn(),
    defaultIntegrationsMock: vi.fn(() => [
      { name: 'Console' },
      { name: 'OnUncaughtException' },
      { name: 'OnUnhandledRejection' },
    ]),
    captureMessageMock: vi.fn(),
    flushMock: vi.fn().mockResolvedValue(true),
    initMock: vi.fn(),
    readFileSyncMock: vi.fn<(path: string, encoding: string) => string>(
      (path: string) => {
        throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' });
      },
    ),
    setContextMock: setContext,
    setFingerprintMock: setFingerprint,
    setLevelMock: setLevel,
    setTagMock: setTag,
    withScopeMock: vi.fn(
      (
        callback: (scope: {
          setLevel: typeof setLevel;
          setTag: typeof setTag;
          setContext: typeof setContext;
          setFingerprint: typeof setFingerprint;
        }) => void,
      ) => {
        callback({
          setLevel,
          setTag,
          setContext,
          setFingerprint,
        });
      },
    ),
  };
});

vi.mock('node:fs', () => ({
  readFileSync: readFileSyncMock,
}));

vi.mock('@sentry/node', () => ({
  captureException: captureExceptionMock,
  captureMessage: captureMessageMock,
  flush: flushMock,
  getDefaultIntegrationsWithoutPerformance: defaultIntegrationsMock,
  init: initMock,
  withScope: withScopeMock,
}));

describe('worker sentry monitoring', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    delete process.env.WORKER_SENTRY_DSN;
    delete process.env.SENTRY_DSN;
    delete process.env.R_APP_ENV;
    delete process.env.APP_ENV;
    delete process.env.NODE_ENV;
    delete process.env.WORKER_RELEASE_TAG;
    delete process.env.R_WORKER_RELEASE_CHANNEL;
    delete process.env.VERCEL_GIT_COMMIT_SHA;
    delete process.env.GITHUB_SHA;
    delete process.env.RELEASE_VERSION;
    delete process.env.ROOMOTE_WORKER_DEPLOYMENT_SLUG;
    delete process.env.ROOMOTE_WORKER_ENVIRONMENT_ID;
    delete process.env.ROOMOTE_WORKER_COMPUTE_PROVIDER;
    delete process.env.ROOMOTE_WORKER_COMPUTE_FINGERPRINT;
    delete process.env.ROOMOTE_WORKER_COMPUTE_FINGERPRINT_KIND;
    process.env.SENTRY_DSN = 'https://shared.example/1';
    readFileSyncMock.mockImplementation((path: string) => {
      throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' });
    });
  });

  it('initializes the worker Sentry client from an explicit DSN and prefers worker release metadata', async () => {
    process.env.R_APP_ENV = 'production';
    process.env.WORKER_SENTRY_DSN = 'https://worker.example/1';
    process.env.VERCEL_GIT_COMMIT_SHA = 'abc123';
    process.env.WORKER_RELEASE_TAG = 'worker-v1.2.3';
    readFileSyncMock.mockImplementation((path: string) => {
      if (path === '/sandbox/worker/VERSION') {
        return '1.2.3\n';
      }

      if (path === '/sandbox/worker/COMMIT') {
        return 'def456\n';
      }

      throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' });
    });

    const { initWorkerSentry } = await import('./sentry');

    expect(initWorkerSentry()).toBe(true);
    expect(initMock).toHaveBeenCalledWith(
      expect.objectContaining({
        defaultIntegrations: [{ name: 'Console' }],
        dsn: 'https://worker.example/1',
        enabled: true,
        environment: 'production',
        initialScope: {
          tags: {
            'roomote.service': 'worker',
            'roomote.worker_commit': 'def456',
            'roomote.worker_release_tag': 'worker-v1.2.3',
            'roomote.worker_version': '1.2.3',
          },
        },
        release: 'worker-v1.2.3',
        serverName: 'worker',
      }),
    );
  });

  it('stays disabled outside development when no DSN is configured', async () => {
    process.env.R_APP_ENV = 'production';
    delete process.env.SENTRY_DSN;

    const { initWorkerSentry } = await import('./sentry');

    expect(initWorkerSentry()).toBe(false);
    expect(initMock).toHaveBeenCalledWith(
      expect.objectContaining({
        dsn: undefined,
        enabled: false,
        environment: 'production',
      }),
    );
  });

  it('falls back to an inferred release tag from the VERSION file when the env var is missing', async () => {
    readFileSyncMock.mockImplementation((path: string) => {
      if (path === '/sandbox/worker/VERSION') {
        return 'local-dev\n';
      }

      if (path === '/sandbox/worker/COMMIT') {
        return 'fedcba\n';
      }

      throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' });
    });

    const { initWorkerSentry } = await import('./sentry');

    initWorkerSentry();

    expect(initMock).toHaveBeenCalledWith(
      expect.objectContaining({
        initialScope: {
          tags: {
            'roomote.service': 'worker',
            'roomote.worker_commit': 'fedcba',
            'roomote.worker_release_tag': 'worker-vlocal-dev',
            'roomote.worker_version': 'local-dev',
          },
        },
        release: 'worker-vlocal-dev',
      }),
    );
  });

  it('prefers the installed worker release tag metadata over app-env inference when the env var is missing', async () => {
    process.env.R_APP_ENV = 'preview';

    readFileSyncMock.mockImplementation((path: string) => {
      if (path === '/sandbox/worker/WORKER_RELEASE_TAG') {
        return 'worker-vlocal-dev\n';
      }

      if (path === '/sandbox/worker/VERSION') {
        return 'local-dev\n';
      }

      if (path === '/sandbox/worker/COMMIT') {
        return 'fedcba\n';
      }

      throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' });
    });

    const { initWorkerSentry } = await import('./sentry');

    initWorkerSentry();

    expect(initMock).toHaveBeenCalledWith(
      expect.objectContaining({
        initialScope: {
          tags: {
            'roomote.service': 'worker',
            'roomote.worker_commit': 'fedcba',
            'roomote.worker_release_tag': 'worker-vlocal-dev',
            'roomote.worker_version': 'local-dev',
          },
        },
        release: 'worker-vlocal-dev',
      }),
    );
  });

  it('defaults worker sentry environment tagging to development when no app env is set', async () => {
    process.env.NODE_ENV = 'production';

    const { initWorkerSentry } = await import('./sentry');

    initWorkerSentry();

    expect(initMock).toHaveBeenCalledWith(
      expect.objectContaining({
        environment: 'development',
      }),
    );
  });

  it('prefers explicit app env values over the node env for sentry tagging', async () => {
    process.env.APP_ENV = 'preview';
    process.env.NODE_ENV = 'production';

    const { initWorkerSentry } = await import('./sentry');

    initWorkerSentry();

    expect(initMock).toHaveBeenCalledWith(
      expect.objectContaining({
        environment: 'preview',
      }),
    );
  });

  it('disables Sentry in development', async () => {
    process.env.R_APP_ENV = 'development';

    const { initWorkerSentry } = await import('./sentry');

    expect(initWorkerSentry()).toBe(false);
    expect(initMock).toHaveBeenCalledWith(
      expect.objectContaining({
        enabled: false,
        environment: 'development',
      }),
    );
  });

  it('does not register a beforeSend hook for worker Sentry', async () => {
    process.env.R_APP_ENV = 'preview';

    const { initWorkerSentry } = await import('./sentry');

    initWorkerSentry();

    expect(initMock).toHaveBeenCalledWith(
      expect.not.objectContaining({
        beforeSend: expect.any(Function),
      }),
    );
  });

  it('captures worker exceptions when enabled', async () => {
    process.env.R_APP_ENV = 'preview';
    process.env.ROOMOTE_WORKER_DEPLOYMENT_SLUG = 'roomote';
    process.env.ROOMOTE_WORKER_ENVIRONMENT_ID = 'env_123';
    process.env.ROOMOTE_WORKER_COMPUTE_PROVIDER = 'roomote';
    process.env.ROOMOTE_WORKER_COMPUTE_FINGERPRINT = 'sandbox-roomote-noble';
    process.env.ROOMOTE_WORKER_COMPUTE_FINGERPRINT_KIND = 'runtime';

    const { captureWorkerException, initWorkerSentry } =
      await import('./sentry');
    const { setWorkerRuntimeContext } = await import('./runtime-context');

    initWorkerSentry();
    setWorkerRuntimeContext({ taskId: 'task-7' });
    captureWorkerException(new Error('boom'), {
      runId: 7,
      stage: 'handleTaskRunError',
    });

    expect(withScopeMock).toHaveBeenCalledTimes(1);
    expect(setLevelMock).toHaveBeenCalledWith('error');
    expect(setTagMock).toHaveBeenCalledWith('roomote.task_id', 'task-7');
    expect(setTagMock).toHaveBeenCalledWith('roomote.task_run_id', '7');
    expect(setTagMock).toHaveBeenCalledWith(
      'roomote.environment_id',
      'env_123',
    );
    expect(setTagMock).toHaveBeenCalledWith(
      'roomote.compute_provider',
      'roomote',
    );
    expect(setTagMock).toHaveBeenCalledWith(
      'roomote.signal',
      'worker-exception',
    );
    expect(setContextMock).toHaveBeenCalledWith('worker', {
      runId: 7,
      computeProvider: 'roomote',
      computeProviderFingerprint: 'sandbox-roomote-noble',
      computeProviderFingerprintKind: 'runtime',
      environmentId: 'env_123',
      deploymentSlug: 'roomote',
      stage: 'handleTaskRunError',
      taskId: 'task-7',
    });
    expect(setFingerprintMock).toHaveBeenCalledWith([
      'roomote-worker-exception',
      'taskId',
      'task-7',
    ]);
    expect(captureExceptionMock).toHaveBeenCalledWith(expect.any(Error));
  });

  it('uses a stable auth-proxy fingerprint for loopback ECONNREFUSED errors', async () => {
    process.env.R_APP_ENV = 'preview';

    const { captureWorkerException, initWorkerSentry } =
      await import('./sentry');

    initWorkerSentry();

    const multiplexError = Object.assign(
      new Error('connect ECONNREFUSED 127.0.0.1:3000'),
      {
        address: '127.0.0.1',
        code: 'ECONNREFUSED',
        port: 3000,
      },
    );
    const authProxyError = Object.assign(
      new Error('connect ECONNREFUSED localhost:5001'),
      {
        address: 'localhost',
        code: 'ECONNREFUSED',
        port: 5001,
      },
    );

    captureWorkerException(multiplexError, {
      runId: 17,
      environmentId: 'env_preview_a',
      stage: 'multiplexAuthProxy.proxy.error',
      targetPort: 3000,
      taskId: 'task-a',
    });
    captureWorkerException(authProxyError, {
      runId: 18,
      environmentId: 'env_preview_b',
      stage: 'authProxy.proxy.error',
      targetPort: 5001,
      taskId: 'task-b',
    });

    expect(setFingerprintMock.mock.calls.slice(-2)).toEqual([
      [['roomote-worker-loopback-connection-refused', 'auth-proxy', 'preview']],
      [['roomote-worker-loopback-connection-refused', 'auth-proxy', 'preview']],
    ]);
  });

  it('falls back to task run id for worker exception fingerprints when task id is unavailable', async () => {
    process.env.R_APP_ENV = 'preview';

    const { captureWorkerException, initWorkerSentry } =
      await import('./sentry');

    initWorkerSentry();
    captureWorkerException(new Error('boom'), {
      runId: 17,
      stage: 'handleTaskRunError',
    });

    expect(setFingerprintMock).toHaveBeenCalledWith([
      'roomote-worker-exception',
      'runId',
      '17',
    ]);
  });

  it('keeps the existing fallback fingerprinting for non-auth-proxy loopback ECONNREFUSED errors', async () => {
    process.env.R_APP_ENV = 'preview';

    const { captureWorkerException, initWorkerSentry } =
      await import('./sentry');

    initWorkerSentry();
    captureWorkerException(new Error('connect ECONNREFUSED 127.0.0.1:3001'), {
      stage: 'handleTaskRunError',
      taskId: 'task-17',
    });

    expect(setFingerprintMock).toHaveBeenCalledWith([
      'roomote-worker-exception',
      'taskId',
      'task-17',
    ]);
  });

  it('keeps the existing fallback fingerprinting for non-ECONNREFUSED auth-proxy errors', async () => {
    process.env.R_APP_ENV = 'preview';

    const { captureWorkerException, initWorkerSentry } =
      await import('./sentry');

    initWorkerSentry();
    captureWorkerException(new Error('connect ETIMEDOUT 127.0.0.1:3001'), {
      stage: 'multiplexAuthProxy.proxy.error',
      taskId: 'task-17',
    });

    expect(setFingerprintMock).toHaveBeenCalledWith([
      'roomote-worker-exception',
      'taskId',
      'task-17',
    ]);
  });

  it('fingerprints TRPC client errors by message, environment, and compute provider', async () => {
    process.env.R_APP_ENV = 'preview';
    process.env.ROOMOTE_WORKER_COMPUTE_PROVIDER = 'roomote';

    const { captureWorkerException, initWorkerSentry } =
      await import('./sentry');

    initWorkerSentry();

    const error = new Error('fetch failed');
    error.name = 'TRPCClientError';

    captureWorkerException(error, {
      runId: 17,
      stage: 'handleTaskRunError',
      taskId: 'task-17',
    });

    expect(setFingerprintMock).toHaveBeenCalledWith([
      'trpc-client-error',
      'fetch failed',
      'preview',
      'roomote',
    ]);
  });

  it('falls back to environment id for worker exception fingerprints when task and task run ids are unavailable', async () => {
    process.env.R_APP_ENV = 'preview';

    const { captureWorkerException, initWorkerSentry } =
      await import('./sentry');

    initWorkerSentry();
    captureWorkerException(new Error('boom'), {
      environmentId: 'env_setup',
      stage: 'setupEnvironment',
    });

    expect(setFingerprintMock).toHaveBeenCalledWith([
      'roomote-worker-exception',
      'environmentId',
      'env_setup',
    ]);
  });

  it('falls back to stage for worker exception fingerprints when no richer context exists', async () => {
    process.env.R_APP_ENV = 'preview';

    const { captureWorkerException, initWorkerSentry } =
      await import('./sentry');

    initWorkerSentry();
    captureWorkerException(new Error('boom'), {
      stage: 'program.parseAsync',
    });

    expect(setFingerprintMock).toHaveBeenCalledWith([
      'roomote-worker-exception',
      'stage',
      'program.parseAsync',
    ]);
  });

  it('captures worker messages and generic error logs when enabled', async () => {
    process.env.R_APP_ENV = 'preview';

    const { captureWorkerErrorLog, captureWorkerMessage, initWorkerSentry } =
      await import('./sentry');

    initWorkerSentry();
    captureWorkerMessage('boom message', {
      runId: 9,
      stage: 'message',
    });
    captureWorkerErrorLog(['log-only failure'], {
      runId: 11,
      stage: 'logger',
    });

    expect(captureMessageMock).toHaveBeenCalledWith('boom message', 'error');
    expect(captureMessageMock).toHaveBeenCalledWith(
      'log-only failure',
      'error',
    );
    expect(setTagMock).toHaveBeenCalledWith('roomote.task_run_id', '9');
    expect(setTagMock).toHaveBeenCalledWith('roomote.task_run_id', '11');
    expect(setTagMock).toHaveBeenCalledWith('roomote.signal', 'worker-message');
  });

  it('captures worker warning messages with custom signal and component tags', async () => {
    process.env.R_APP_ENV = 'preview';

    const { captureWorkerMessage, initWorkerSentry } = await import('./sentry');

    initWorkerSentry();
    captureWorkerMessage(
      'cancel restart requested',
      {
        runId: 12,
        sessionId: 'session-12',
      },
      {
        level: 'warning',
        signal: 'acp-cancel-restart-requested',
        component: 'acp-harness',
      },
    );

    expect(setLevelMock).toHaveBeenCalledWith('warning');
    expect(setTagMock).toHaveBeenCalledWith('roomote.task_run_id', '12');
    expect(setTagMock).toHaveBeenCalledWith(
      'roomote.signal',
      'acp-cancel-restart-requested',
    );
    expect(setTagMock).toHaveBeenCalledWith('roomote.component', 'acp-harness');
    expect(captureMessageMock).toHaveBeenCalledWith(
      'cancel restart requested',
      'warning',
    );
  });

  it('captures worker messages with additional custom tags', async () => {
    process.env.R_APP_ENV = 'preview';

    const { captureWorkerMessage, initWorkerSentry } = await import('./sentry');

    initWorkerSentry();
    captureWorkerMessage(
      'OpenCode inference turn failed',
      {
        runId: 33,
        turnId: 'turn-33',
      },
      {
        signal: 'inference-turn-failed',
        component: 'opencode-server-harness',
        tags: {
          'roomote.inference_failure_reason': 'insufficient_quota',
          'roomote.inference_model': 'claude-sonnet-4-5',
          'roomote.harness_error_info_type': 'other',
        },
      },
    );

    expect(setTagMock).toHaveBeenCalledWith(
      'roomote.inference_failure_reason',
      'insufficient_quota',
    );
    expect(setTagMock).toHaveBeenCalledWith(
      'roomote.inference_model',
      'claude-sonnet-4-5',
    );
    expect(setTagMock).toHaveBeenCalledWith(
      'roomote.harness_error_info_type',
      'other',
    );
    expect(captureMessageMock).toHaveBeenCalledWith(
      'OpenCode inference turn failed',
      'error',
    );
  });

  it('creates fatal process handlers that capture and exit on unhandled failures', async () => {
    process.env.R_APP_ENV = 'preview';

    const { createWorkerFatalProcessHandlers, initWorkerSentry } =
      await import('./sentry');

    const logger = {
      error: vi.fn(),
      warn: vi.fn(),
    };
    const exit = vi.fn();

    initWorkerSentry();

    const { handleUncaughtException, handleUnhandledRejection } =
      createWorkerFatalProcessHandlers({
        logger,
        uncaughtExceptionStage: 'mcp.uncaughtException',
        unhandledRejectionStage: 'mcp.unhandledRejection',
        exit,
      });

    handleUncaughtException(new Error('boom'));
    handleUnhandledRejection('nope');

    expect(logger.error).toHaveBeenCalledWith(
      '[uncaughtException] Fatal:',
      expect.any(Error),
    );
    expect(logger.error).toHaveBeenCalledWith(
      '[unhandledRejection] Fatal:',
      'nope',
    );
    expect(captureExceptionMock).toHaveBeenCalledWith(expect.any(Error));
    expect(exit).toHaveBeenCalledTimes(2);
    expect(setContextMock).toHaveBeenCalledWith('worker', {
      stage: 'mcp.uncaughtException',
    });
    expect(setContextMock).toHaveBeenCalledWith('worker', {
      stage: 'mcp.unhandledRejection',
    });
  });

  it('creates fatal process handlers that skip ignorable failures', async () => {
    const { createWorkerFatalProcessHandlers, initWorkerSentry } =
      await import('./sentry');

    const logger = {
      error: vi.fn(),
      warn: vi.fn(),
    };
    const exit = vi.fn();

    initWorkerSentry();

    const { handleUncaughtException, handleUnhandledRejection } =
      createWorkerFatalProcessHandlers({
        isIgnorableError: () => true,
        logger,
        uncaughtExceptionStage: 'ignored.uncaughtException',
        unhandledRejectionStage: 'ignored.unhandledRejection',
        exit,
      });

    handleUncaughtException(new Error('ignore-me'));
    handleUnhandledRejection('ignore-me-too');

    expect(logger.warn).toHaveBeenCalledTimes(2);
    expect(logger.error).not.toHaveBeenCalled();
    expect(captureExceptionMock).not.toHaveBeenCalled();
    expect(captureMessageMock).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
  });
});
