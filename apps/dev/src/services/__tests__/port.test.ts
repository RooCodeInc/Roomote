import { createConnection, Socket, type NetConnectOpts } from 'net';

import { PortService } from '../port';

vi.mock('net', async (importOriginal) => ({
  ...(await importOriginal<typeof import('net')>()),
  createConnection: vi.fn(),
}));

vi.mock('ora', () => ({
  default: () => ({ start: () => ({ succeed: vi.fn(), text: '' }) }),
}));

describe('PortService.checkPorts', () => {
  const occupiedPorts = new Set<number>();

  beforeEach(() => {
    vi.useFakeTimers();
    occupiedPorts.clear();
    vi.mocked(createConnection).mockImplementation(
      (options: NetConnectOpts | number | string) => {
        const socket = new Socket();
        const port =
          typeof options === 'object' && 'port' in options
            ? Number(options.port)
            : undefined;
        queueMicrotask(() => {
          if (port !== undefined && occupiedPorts.has(port)) {
            socket.emit('connect');
          } else {
            socket.emit('error', new Error('ECONNREFUSED'));
          }
        });
        return socket;
      },
    );
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('allows startup when the Roomote ports are available', async () => {
    await expect(PortService.checkPorts()).resolves.toBeUndefined();
  });

  it('allows an unrelated service to use port 7060', async () => {
    occupiedPorts.add(7060);
    const result = expect(PortService.checkPorts()).resolves.toBeUndefined();
    await Promise.all([result, vi.runAllTimersAsync()]);
  });

  it.each([13000, 13001, 13002, 18081])(
    'still blocks startup when required port %i stays occupied',
    async (port) => {
      occupiedPorts.add(port);
      const result = expect(PortService.checkPorts()).rejects.toThrow(
        `The following required ports are already in use: ${port}`,
      );
      await Promise.all([result, vi.runAllTimersAsync()]);
    },
  );
});
