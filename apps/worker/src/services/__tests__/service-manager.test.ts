import type { StartupLogger } from '../../logging';
import type { ServiceDefinition } from '../types';
import { ServiceManager } from '../service-manager';

const { mockExecute, mockGetServiceDefinition } = vi.hoisted(() => ({
  mockExecute: vi
    .fn()
    .mockResolvedValue({ success: true, stdout: '', stderr: '' }),
  mockGetServiceDefinition: vi.fn(),
}));

vi.mock('../../command-executor', () => ({
  CommandExecutor: vi.fn().mockImplementation(function () {
    return { execute: mockExecute };
  }),
}));

vi.mock('../service-definition', () => ({
  getServiceDefinition: mockGetServiceDefinition,
}));

function createServiceDefinition(
  overrides: Partial<ServiceDefinition> = {},
): ServiceDefinition {
  return {
    defaultPort: 5432,
    install: vi.fn().mockResolvedValue(undefined),
    start: vi.fn().mockResolvedValue(undefined),
    healthCheck: vi.fn().mockResolvedValue(false),
    verifyManagedInstance: undefined,
    getConnectionInfo: vi.fn().mockReturnValue({
      connectionString: 'postgresql://postgres@localhost:5432/postgres',
      envVars: {
        DATABASE_URL: 'postgresql://postgres@localhost:5432/postgres',
      },
    }),
    ...overrides,
  };
}

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;

  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });

  return { promise, resolve, reject };
}

const logger = {
  debug: {
    log: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
  userLog: {
    log: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
} as unknown as StartupLogger;

describe('ServiceManager', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExecute.mockResolvedValue({ success: true, stdout: '', stderr: '' });
  });

  it('continues when startup reports an error but the managed instance is verified', async () => {
    const definition = createServiceDefinition({
      healthCheck: vi.fn().mockResolvedValue(true),
      verifyManagedInstance: vi.fn().mockResolvedValue(true),
      start: vi.fn().mockRejectedValue(new Error('port already in use')),
    });

    mockGetServiceDefinition.mockReturnValue(definition);

    const manager = new ServiceManager('/workspace', {});
    const services = await manager.startServices(logger, [
      { name: 'postgres17', port: 5432 },
    ]);

    expect(definition.install).toHaveBeenCalledTimes(1);
    expect(definition.start).toHaveBeenCalledTimes(1);
    expect(definition.verifyManagedInstance).toHaveBeenCalledTimes(1);
    expect(services).toHaveLength(1);
    expect(services[0]?.connectionString).toContain('5432');
  });

  it('verifies the managed instance after a successful startup', async () => {
    const definition = createServiceDefinition({
      healthCheck: vi.fn().mockResolvedValue(true),
      verifyManagedInstance: vi.fn().mockResolvedValue(true),
    });

    mockGetServiceDefinition.mockReturnValue(definition);

    const manager = new ServiceManager('/workspace', {});
    const services = await manager.startServices(logger, [
      { name: 'postgres17', port: 5432 },
    ]);

    expect(definition.start).toHaveBeenCalledTimes(1);
    expect(definition.verifyManagedInstance).toHaveBeenCalledTimes(1);
    expect(services).toHaveLength(1);
  });

  it('runs installs concurrently but waits for all installs before starting services', async () => {
    const firstInstall = createDeferred<void>();
    const secondInstall = createDeferred<void>();

    const postgresDefinition = createServiceDefinition({
      install: vi.fn().mockImplementation(() => firstInstall.promise),
      healthCheck: vi.fn().mockResolvedValue(true),
    });
    const redisDefinition = createServiceDefinition({
      defaultPort: 6379,
      install: vi.fn().mockImplementation(() => secondInstall.promise),
      healthCheck: vi.fn().mockResolvedValue(true),
      getConnectionInfo: vi.fn().mockReturnValue({
        connectionString: 'redis://localhost:6379',
        envVars: {
          REDIS_URL: 'redis://localhost:6379',
        },
      }),
    });

    mockGetServiceDefinition.mockImplementation((name) => {
      switch (name) {
        case 'postgres17':
          return postgresDefinition;
        case 'redis7':
          return redisDefinition;
        default:
          throw new Error(`Unexpected service name: ${name}`);
      }
    });

    const manager = new ServiceManager('/workspace', {});
    const servicesPromise = manager.startServices(logger, [
      { name: 'postgres17', port: 5432 },
      { name: 'redis7', port: 6379 },
    ]);

    await vi.waitFor(() => {
      expect(postgresDefinition.install).toHaveBeenCalledTimes(1);
      expect(redisDefinition.install).toHaveBeenCalledTimes(1);
    });

    expect(postgresDefinition.start).not.toHaveBeenCalled();
    expect(redisDefinition.start).not.toHaveBeenCalled();

    secondInstall.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(postgresDefinition.start).not.toHaveBeenCalled();
    expect(redisDefinition.start).not.toHaveBeenCalled();

    firstInstall.resolve();

    const services = await servicesPromise;

    expect(postgresDefinition.start).toHaveBeenCalledTimes(1);
    expect(redisDefinition.start).toHaveBeenCalledTimes(1);
    expect(services).toHaveLength(2);
  });

  it('fails when startup succeeds but the managed instance verification fails', async () => {
    const definition = createServiceDefinition({
      healthCheck: vi.fn().mockResolvedValue(true),
      verifyManagedInstance: vi.fn().mockResolvedValue(false),
    });

    mockGetServiceDefinition.mockReturnValue(definition);

    const manager = new ServiceManager('/workspace', {});

    await expect(
      manager.startServices(logger, [{ name: 'postgres17', port: 5432 }]),
    ).rejects.toThrow(
      'postgres17 did not start the managed service instance on port 5432',
    );
  });

  it('fails when startup errors and the service cannot verify ownership', async () => {
    const definition = createServiceDefinition({
      healthCheck: vi.fn().mockResolvedValue(true),
      verifyManagedInstance: vi.fn().mockResolvedValue(false),
      start: vi.fn().mockRejectedValue(new Error('port already in use')),
    });

    mockGetServiceDefinition.mockReturnValue(definition);

    const manager = new ServiceManager('/workspace', {});

    await expect(
      manager.startServices(logger, [{ name: 'postgres17', port: 5432 }]),
    ).rejects.toThrow('port already in use');
  });

  it('still fails when startup errors and the service never becomes healthy', async () => {
    const definition = createServiceDefinition({
      healthCheck: vi.fn().mockResolvedValue(false),
      verifyManagedInstance: vi.fn().mockResolvedValue(false),
      start: vi.fn().mockRejectedValue(new Error('startup failed')),
    });

    mockGetServiceDefinition.mockReturnValue(definition);

    const manager = new ServiceManager('/workspace', {});

    await expect(
      manager.startServices(logger, [{ name: 'postgres17', port: 5432 }]),
    ).rejects.toThrow('startup failed');
  });
});
