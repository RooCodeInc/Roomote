const captureExceptionMock = vi.fn();
const captureMessageMock = vi.fn();
const flushMock = vi.fn(async () => true);
const initMock = vi.fn();
const scopeSetContextMock = vi.fn();
const scopeSetFingerprintMock = vi.fn();
const scopeSetLevelMock = vi.fn();
const scopeSetTagMock = vi.fn();
const CONTROLLER_SENTRY_STATE_KEY = '__roomoteControllerSentryState__' as const;
const withScopeMock = vi.fn(
  (
    callback: (scope: {
      setContext: typeof scopeSetContextMock;
      setFingerprint: typeof scopeSetFingerprintMock;
      setLevel: typeof scopeSetLevelMock;
      setTag: typeof scopeSetTagMock;
    }) => void,
  ) => {
    callback({
      setContext: scopeSetContextMock,
      setFingerprint: scopeSetFingerprintMock,
      setLevel: scopeSetLevelMock,
      setTag: scopeSetTagMock,
    });
  },
);

vi.mock('@sentry/node', () => ({
  captureException: captureExceptionMock,
  captureMessage: captureMessageMock,
  flush: flushMock,
  init: initMock,
  withScope: withScopeMock,
}));

async function loadSentryModule() {
  return import('./sentry');
}

describe('controller sentry monitoring', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    delete (globalThis as Record<string, unknown>)[CONTROLLER_SENTRY_STATE_KEY];

    delete process.env.CONTROLLER_SENTRY_DSN;
    delete process.env.SENTRY_DSN;
    delete process.env.APP_ENV;
    delete process.env.NODE_ENV;
    delete process.env.VERCEL_GIT_COMMIT_SHA;
    delete process.env.GITHUB_SHA;
    delete process.env.RELEASE_VERSION;

    process.env.SENTRY_DSN = 'https://shared.example/1';
  });

  it('initializes with explicit DSN and controller metadata', async () => {
    process.env.APP_ENV = 'preview';
    process.env.GITHUB_SHA = 'abc123';
    process.env.CONTROLLER_SENTRY_DSN = 'https://controller.example/1';

    const { initControllerSentry } = await loadSentryModule();

    expect(initControllerSentry()).toBe(true);
    expect(initMock).toHaveBeenCalledWith({
      debug: false,
      dsn: 'https://controller.example/1',
      enabled: true,
      environment: 'preview',
      initialScope: {
        tags: {
          'roomote.service': 'controller',
        },
      },
      maxValueLength: 8_192,
      release: 'abc123',
      sendDefaultPii: true,
      serverName: 'controller',
    });
  });

  it('prefers CONTROLLER_SENTRY_DSN over SENTRY_DSN', async () => {
    process.env.CONTROLLER_SENTRY_DSN = 'https://controller.example/1';
    process.env.SENTRY_DSN = 'https://shared.example/1';

    const { initControllerSentry } = await loadSentryModule();

    initControllerSentry();

    expect(initMock).toHaveBeenCalledWith(
      expect.objectContaining({
        dsn: 'https://controller.example/1',
      }),
    );
  });

  it('stays disabled outside development when no DSN is configured', async () => {
    process.env.APP_ENV = 'preview';
    delete process.env.SENTRY_DSN;

    const { initControllerSentry } = await loadSentryModule();

    expect(initControllerSentry()).toBe(false);
    expect(initMock).toHaveBeenCalledWith(
      expect.objectContaining({
        dsn: undefined,
        enabled: false,
        environment: 'preview',
      }),
    );
  });

  it('disables Sentry in development', async () => {
    process.env.APP_ENV = 'development';

    const { initControllerSentry } = await loadSentryModule();

    expect(initControllerSentry()).toBe(false);
    expect(initMock).toHaveBeenCalledWith(
      expect.objectContaining({
        enabled: false,
        environment: 'development',
      }),
    );
  });

  it('captures exceptions with controller context', async () => {
    const { captureControllerException } = await loadSentryModule();

    captureControllerException(new Error('boom'), {
      jobId: 42,
      phase: 'startup',
    });

    expect(withScopeMock).toHaveBeenCalledTimes(1);
    expect(scopeSetLevelMock).toHaveBeenCalledWith('error');
    expect(scopeSetTagMock).toHaveBeenCalledWith(
      'roomote.signal',
      'controller-exception',
    );
    expect(scopeSetTagMock).toHaveBeenCalledWith('roomote.phase', 'startup');
    expect(scopeSetContextMock).toHaveBeenCalledWith('controller', {
      jobId: 42,
      phase: 'startup',
    });
    expect(scopeSetFingerprintMock).not.toHaveBeenCalled();
    expect(captureExceptionMock).toHaveBeenCalledWith(expect.any(Error));
    expect((captureExceptionMock.mock.calls[0]?.[0] as Error).message).toBe(
      'boom',
    );
  });

  it('fingerprints Modal RPC failures by method and gRPC status', async () => {
    const { ModalRpcError } = await import('@roomote/compute-providers');
    const { captureControllerException } = await loadSentryModule();

    captureControllerException(
      new ModalRpcError(
        '/modal.task_command_router.TaskCommandRouter/TaskExecStart NOT_FOUND: Modal Sandbox with container ID ta-01KT20Z4JR98XWKQNBNVSXWWNH not found. This means this Sandbox has already shut down. (Error code: 7KJF5ETD)',
        {
          grpcStatus: 'NOT_FOUND',
          modalErrorCode: '7KJF5ETD',
          operation: 'command_exec',
          rpcMethod: 'TaskExecStart',
          rpcPath: '/modal.task_command_router.TaskCommandRouter/TaskExecStart',
          rpcService: 'modal.task_command_router.TaskCommandRouter',
        },
      ),
      {
        jobId: 42,
        phase: 'spawn_worker',
        provider: 'modal',
      },
    );

    expect(scopeSetTagMock).toHaveBeenCalledWith('roomote.provider', 'modal');
    expect(scopeSetTagMock).toHaveBeenCalledWith(
      'roomote.phase',
      'spawn_worker',
    );
    expect(scopeSetTagMock).toHaveBeenCalledWith(
      'roomote.modal_rpc_service',
      'modal.task_command_router.TaskCommandRouter',
    );
    expect(scopeSetTagMock).toHaveBeenCalledWith(
      'roomote.modal_rpc_method',
      'TaskExecStart',
    );
    expect(scopeSetTagMock).toHaveBeenCalledWith(
      'roomote.grpc_status',
      'NOT_FOUND',
    );
    expect(scopeSetTagMock).toHaveBeenCalledWith(
      'roomote.modal_error_code',
      '7KJF5ETD',
    );
    expect(scopeSetTagMock).toHaveBeenCalledWith(
      'roomote.modal_operation',
      'command_exec',
    );
    expect(scopeSetFingerprintMock).toHaveBeenCalledWith([
      'roomote-controller-exception',
      'provider:modal',
      'phase:spawn_worker',
      'operation:command_exec',
      'rpc:/modal.task_command_router.TaskCommandRouter/TaskExecStart',
      'grpc_status:NOT_FOUND',
    ]);
  });

  it('prefers nested Modal status codes for fingerprints when present', async () => {
    const { ModalRpcError } = await import('@roomote/compute-providers');
    const { captureControllerException } = await loadSentryModule();

    captureControllerException(
      new ModalRpcError(
        '/modal.client.ModalClient/SandboxCreate UNAVAILABLE: Authorization check failed for app roomote-production; status = StatusCode.DEADLINE_EXCEEDED',
        {
          grpcStatus: 'DEADLINE_EXCEEDED',
          operation: 'create_instance',
          rpcMethod: 'SandboxCreate',
          rpcPath: '/modal.client.ModalClient/SandboxCreate',
          rpcService: 'modal.client.ModalClient',
        },
      ),
      {
        jobId: 42,
        phase: 'spawn_worker',
        provider: 'modal',
      },
    );

    expect(scopeSetTagMock).toHaveBeenCalledWith(
      'roomote.modal_rpc_method',
      'SandboxCreate',
    );
    expect(scopeSetTagMock).toHaveBeenCalledWith(
      'roomote.grpc_status',
      'DEADLINE_EXCEEDED',
    );
    expect(scopeSetFingerprintMock).toHaveBeenCalledWith([
      'roomote-controller-exception',
      'provider:modal',
      'phase:spawn_worker',
      'operation:create_instance',
      'rpc:/modal.client.ModalClient/SandboxCreate',
      'grpc_status:DEADLINE_EXCEEDED',
    ]);
  });

  it('captures message events with controller tags and context', async () => {
    const { captureControllerMessage } = await loadSentryModule();

    captureControllerMessage(
      'Controller started task using database fallback logic',
      {
        jobId: 42,
        phase: 'database_fallback',
      },
      {
        component: 'dequeue-loop',
        level: 'error',
        signal: 'database-fallback-task-start',
      },
    );

    expect(withScopeMock).toHaveBeenCalledTimes(1);
    expect(scopeSetLevelMock).toHaveBeenCalledWith('error');
    expect(scopeSetTagMock).toHaveBeenCalledWith(
      'roomote.signal',
      'database-fallback-task-start',
    );
    expect(scopeSetTagMock).toHaveBeenCalledWith(
      'roomote.component',
      'dequeue-loop',
    );
    expect(scopeSetTagMock).toHaveBeenCalledWith(
      'roomote.phase',
      'database_fallback',
    );
    expect(scopeSetContextMock).toHaveBeenCalledWith('controller', {
      jobId: 42,
      phase: 'database_fallback',
    });
    expect(captureMessageMock).toHaveBeenCalledWith(
      'Controller started task using database fallback logic',
      'error',
    );
  });

  it('flushes once initialized', async () => {
    const { flushControllerSentry, initControllerSentry } =
      await loadSentryModule();

    initControllerSentry();

    await expect(flushControllerSentry()).resolves.toBe(true);
    expect(flushMock).toHaveBeenCalledWith(2_000);
  });

  it('reuses shared state across module re-imports', async () => {
    process.env.APP_ENV = 'preview';

    const firstModule = await loadSentryModule();

    expect(firstModule.initControllerSentry()).toBe(true);
    expect(initMock).toHaveBeenCalledTimes(1);

    vi.resetModules();

    const secondModule = await loadSentryModule();

    expect(secondModule.initControllerSentry()).toBe(true);
    expect(initMock).toHaveBeenCalledTimes(1);

    await expect(secondModule.flushControllerSentry()).resolves.toBe(true);
    expect(flushMock).toHaveBeenCalledWith(2_000);
  });
});
