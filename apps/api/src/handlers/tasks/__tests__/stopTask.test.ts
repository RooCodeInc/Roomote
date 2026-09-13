import { stopTask } from '../stopTask';

const { findLatestTaskRun, stopTaskRun } = vi.hoisted(() => ({
  findLatestTaskRun: vi.fn(),
  stopTaskRun: vi.fn(),
}));

vi.mock('../helpers', () => ({ findLatestTaskRun }));
vi.mock('../task-stop', () => ({ stopTaskRun }));

function createContext(body?: { userInitiated?: boolean }) {
  return {
    req: {
      param: () => 'task-1',
      header: (name: string) =>
        body && name === 'content-type' ? 'application/json' : undefined,
      json: async () => body,
    },
    get: () => ({ userId: 'user-1' }),
    json: (value: unknown, status: number | { status: number } = 200) =>
      Response.json(value, {
        status: typeof status === 'number' ? status : status.status,
      }),
  } as unknown as Parameters<typeof stopTask>[0];
}

describe('stopTask', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    findLatestTaskRun.mockResolvedValue({
      id: 42,
      status: 'running',
      sandboxServerUrl: 'http://sandbox.test',
      userId: 'user-1',
      actingUserId: 'user-1',
    });
    stopTaskRun.mockResolvedValue({ success: true, mode: 'sandbox_stop' });
  });

  it('omits user attribution for an autonomous recovery stop', async () => {
    const response = await stopTask(createContext({ userInitiated: false }));

    expect(response.status).toBe(200);
    expect(stopTaskRun).toHaveBeenCalledWith({
      run: expect.objectContaining({ id: 42 }),
      authUserId: 'user-1',
    });
  });

  it('adds user attribution for an explicitly requested stop', async () => {
    const response = await stopTask(createContext({ userInitiated: true }));

    expect(response.status).toBe(200);
    expect(stopTaskRun).toHaveBeenCalledWith({
      run: expect.objectContaining({ id: 42 }),
      authUserId: 'user-1',
      cancelledBy: { source: 'api' },
    });
  });

  it('preserves user attribution for existing payload-free callers', async () => {
    const response = await stopTask(createContext());

    expect(response.status).toBe(200);
    expect(stopTaskRun).toHaveBeenCalledWith({
      run: expect.objectContaining({ id: 42 }),
      authUserId: 'user-1',
      cancelledBy: { source: 'api' },
    });
  });
});
