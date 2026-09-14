import { deliverSessionProxy } from './authenticated-proxy';

const mocks = vi.hoisted(() => ({
  run: vi.fn(),
  ready: vi.fn(),
  register: vi.fn(),
  publish: vi.fn(),
  terminate: vi.fn(),
  event: vi.fn(),
}));
vi.mock('@roomote/db/server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@roomote/db/server')>()),
  db: { query: { taskRuns: { findFirst: mocks.run } } },
  recordTaskRunLifecycleEvent: mocks.event,
  terminateSessionEgressWorkload: mocks.terminate,
}));
vi.mock('@roomote/sdk/server', () => ({
  isSessionEgressBootstrapReady: mocks.ready,
  publishSessionEgressDelivery: mocks.publish,
}));
vi.mock('@roomote/sdk/server/session-egress', () => ({
  createSessionEgressControllerClient: () => ({
    registerProxy: mocks.register,
  }),
}));

const registration = {
  workloadId: '11111111-1111-4111-8111-111111111111',
  sessionId: '22222222-2222-4222-8222-222222222222',
  generation: 3,
  expiresAt: '2099-01-01T00:00:00.000Z',
  admissionMode: 'authenticated_proxy',
  proxyCapability: `rproxy_${'a'.repeat(43)}`,
  proxyCapabilityExpiresAt: '2099-01-01T00:00:00.000Z',
  substitutes: [
    {
      secretRef: '33333333-3333-4333-8333-333333333333',
      label: 'Example',
      origin: 'https://service.example.com',
      headerName: 'authorization',
      headerPrefix: 'Bearer ',
      allowedMethods: ['GET', 'POST'],
      expiresAt: '2099-01-01T00:00:00.000Z',
      substitute: 'rses_fixture',
    },
  ],
};
const input = {
  config: {
    endpoint: 'https://proxy.example.com',
    caBundle: 'public-ca-only',
    apiBaseUrl: 'https://api.example.com',
  },
  runId: 123,
  taskId: 'task-123',
  provider: 'roomote',
  nonce: 'nonce-fixture',
  machineId: 'machine-123',
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.run.mockResolvedValue({
    status: 'running',
    machineId: input.machineId,
  });
  mocks.ready.mockResolvedValue(true);
  mocks.register.mockResolvedValue(registration);
  mocks.publish.mockResolvedValue(undefined);
  mocks.terminate.mockResolvedValue(true);
});

it('waits for bootstrap, writes only public trust, then publishes scoped credentials with the original nonce', async () => {
  const writeFiles = vi.fn().mockResolvedValue(undefined);
  await deliverSessionProxy({ ...input, computeClient: { writeFiles } });
  expect(mocks.ready).toHaveBeenCalledWith(123, input.nonce);
  expect(mocks.ready.mock.invocationCallOrder[0]).toBeLessThan(
    mocks.register.mock.invocationCallOrder[0]!,
  );
  expect(mocks.register).toHaveBeenCalledWith({
    runId: 123,
    provider: 'roomote',
    leaseSeconds: 900,
    capabilitySeconds: 900,
  });
  expect(writeFiles.mock.calls[0]![0].files[0].content.toString()).toBe(
    'public-ca-only',
  );
  expect(writeFiles.mock.invocationCallOrder[0]).toBeLessThan(
    mocks.publish.mock.invocationCallOrder[0]!,
  );
  expect(mocks.publish).toHaveBeenCalledWith(
    123,
    registration,
    expect.objectContaining({
      ROOMOTE_SESSION_EGRESS_ADMISSION_MODE: 'authenticated_proxy',
      ROOMOTE_SESSION_PROXY_CAPABILITY: registration.proxyCapability,
      ROOMOTE_SERVICE_TOKEN_EXAMPLE: 'rses_fixture',
    }),
    input.nonce,
  );
  expect(mocks.publish.mock.calls[0]![2]).not.toHaveProperty(
    'ROOMOTE_SESSION_EGRESS_ENFORCED',
  );
  expect(JSON.stringify(mocks.event.mock.calls)).not.toContain(
    registration.proxyCapability,
  );
});

it('does not issue credentials for a no-longer-active run', async () => {
  mocks.run.mockResolvedValue({ status: 'failed', machineId: input.machineId });
  await expect(
    deliverSessionProxy({ ...input, computeClient: { writeFiles: vi.fn() } }),
  ).rejects.toThrow('credentials are unavailable');
  expect(mocks.register).not.toHaveBeenCalled();
  expect(mocks.publish).not.toHaveBeenCalled();
});

it.each(['write', 'publish'])(
  'cleans up only its own generation after %s failure',
  async (phase) => {
    const writeFiles = vi.fn().mockResolvedValue(undefined);
    if (phase === 'write')
      writeFiles.mockRejectedValue(new Error(registration.proxyCapability));
    else mocks.publish.mockRejectedValue(new Error('stale generation'));
    await expect(
      deliverSessionProxy({ ...input, computeClient: { writeFiles } }),
    ).rejects.toThrow('credentials are unavailable');
    expect(mocks.terminate).toHaveBeenCalledWith(
      registration.workloadId,
      'provision_failed',
      3,
    );
    if (phase === 'write') expect(mocks.publish).not.toHaveBeenCalled();
  },
);
