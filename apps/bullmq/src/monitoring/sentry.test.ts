const captureMessageMock = vi.fn();
const initMock = vi.fn();
const scopeSetContextMock = vi.fn();
const scopeSetLevelMock = vi.fn();
const scopeSetTagMock = vi.fn();
const withScopeMock = vi.fn(
  (
    callback: (scope: {
      setContext: typeof scopeSetContextMock;
      setLevel: typeof scopeSetLevelMock;
      setTag: typeof scopeSetTagMock;
    }) => void,
  ) => {
    callback({
      setContext: scopeSetContextMock,
      setLevel: scopeSetLevelMock,
      setTag: scopeSetTagMock,
    });
  },
);

vi.mock('@sentry/node', () => ({
  captureMessage: captureMessageMock,
  init: initMock,
  withScope: withScopeMock,
}));

async function loadSentryModule() {
  return import('./sentry');
}

describe('BullMQ Sentry monitoring', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    delete process.env.BULLMQ_SENTRY_DSN;
    delete process.env.SENTRY_DSN;
    delete process.env.ROOMOTE_APP_ENV;
    delete process.env.APP_ENV;
    delete process.env.NODE_ENV;
    delete process.env.VERCEL_GIT_COMMIT_SHA;
    delete process.env.GITHUB_SHA;
    delete process.env.RELEASE_VERSION;

    process.env.SENTRY_DSN = 'https://shared.example/1';
  });

  it('initializes with BullMQ metadata outside development', async () => {
    process.env.APP_ENV = 'production';
    process.env.GITHUB_SHA = 'abc123';
    process.env.BULLMQ_SENTRY_DSN = 'https://bullmq.example/1';

    const { initBullMqSentry } = await loadSentryModule();

    expect(initBullMqSentry()).toBe(true);
    expect(initMock).toHaveBeenCalledWith({
      debug: false,
      dsn: 'https://bullmq.example/1',
      enabled: true,
      environment: 'production',
      initialScope: {
        tags: {
          'roomote.service': 'bullmq',
        },
      },
      maxValueLength: 8_192,
      release: 'abc123',
      sendDefaultPii: false,
      serverName: 'bullmq',
    });
  });

  it('prefers BULLMQ_SENTRY_DSN over shared SENTRY_DSN', async () => {
    process.env.APP_ENV = 'production';
    process.env.BULLMQ_SENTRY_DSN = 'https://bullmq.example/1';
    process.env.SENTRY_DSN = 'https://shared.example/1';

    const { initBullMqSentry } = await loadSentryModule();

    initBullMqSentry();

    expect(initMock).toHaveBeenCalledWith(
      expect.objectContaining({ dsn: 'https://bullmq.example/1' }),
    );
  });

  it('stays disabled outside development when no DSN is configured', async () => {
    process.env.APP_ENV = 'production';
    delete process.env.SENTRY_DSN;

    const { initBullMqSentry } = await loadSentryModule();

    expect(initBullMqSentry()).toBe(false);
    expect(initMock).toHaveBeenCalledWith(
      expect.objectContaining({
        dsn: undefined,
        enabled: false,
        environment: 'production',
      }),
    );
  });

  it('captures message events with BullMQ tags and context', async () => {
    process.env.APP_ENV = 'production';

    const { captureBullMqMessage } = await loadSentryModule();

    captureBullMqMessage(
      'Snapshot creation failed',
      {
        cloudJobId: 123,
        computeProvider: 'modal',
        providerErrorCode: 'sandbox_snapshotting',
        providerResponseStatus: 422,
        queueJobId: 'snapshot-job-123',
        sandboxId: 'sbx_123',
        snapshotIntentId: 'snapshot-intent-123',
        snapshotStage: 'create_snapshot',
        taskId: 'task_123',
        taskPhase: 'shutting_down',
        triggerPath: 'due_sleep',
      },
      {
        component: 'snapshot_queue',
        level: 'error',
        signal: 'snapshot-failed',
      },
    );

    expect(withScopeMock).toHaveBeenCalledTimes(1);
    expect(scopeSetLevelMock).toHaveBeenCalledWith('error');
    expect(scopeSetTagMock).toHaveBeenCalledWith(
      'roomote.signal',
      'snapshot-failed',
    );
    expect(scopeSetTagMock).toHaveBeenCalledWith(
      'roomote.component',
      'snapshot_queue',
    );
    expect(scopeSetTagMock).toHaveBeenCalledWith('roomote.cloud_job_id', '123');
    expect(scopeSetTagMock).toHaveBeenCalledWith(
      'roomote.compute_provider',
      'modal',
    );
    expect(scopeSetTagMock).toHaveBeenCalledWith(
      'roomote.provider_error_code',
      'sandbox_snapshotting',
    );
    expect(scopeSetTagMock).toHaveBeenCalledWith(
      'roomote.provider_response_status',
      '422',
    );
    expect(scopeSetTagMock).toHaveBeenCalledWith(
      'roomote.queue_job_id',
      'snapshot-job-123',
    );
    expect(scopeSetTagMock).toHaveBeenCalledWith(
      'roomote.sandbox_id',
      'sbx_123',
    );
    expect(scopeSetTagMock).toHaveBeenCalledWith(
      'roomote.snapshot_intent_id',
      'snapshot-intent-123',
    );
    expect(scopeSetTagMock).toHaveBeenCalledWith(
      'roomote.snapshot_stage',
      'create_snapshot',
    );
    expect(scopeSetTagMock).toHaveBeenCalledWith('roomote.task_id', 'task_123');
    expect(scopeSetTagMock).toHaveBeenCalledWith(
      'roomote.task_phase',
      'shutting_down',
    );
    expect(scopeSetTagMock).toHaveBeenCalledWith(
      'roomote.trigger_path',
      'due_sleep',
    );
    expect(scopeSetContextMock).toHaveBeenCalledWith('bullmq', {
      cloudJobId: 123,
      computeProvider: 'modal',
      providerErrorCode: 'sandbox_snapshotting',
      providerResponseStatus: 422,
      queueJobId: 'snapshot-job-123',
      sandboxId: 'sbx_123',
      snapshotIntentId: 'snapshot-intent-123',
      snapshotStage: 'create_snapshot',
      taskId: 'task_123',
      taskPhase: 'shutting_down',
      triggerPath: 'due_sleep',
    });
    expect(captureMessageMock).toHaveBeenCalledWith(
      'Snapshot creation failed',
      'error',
    );
  });
});
