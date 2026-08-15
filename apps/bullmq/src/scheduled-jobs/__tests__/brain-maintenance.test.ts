const { mockResolveConnection, mockResolveProvider } = vi.hoisted(() => ({
  mockResolveConnection: vi.fn(),
  mockResolveProvider: vi.fn(),
}));

vi.mock('@roomote/sdk/server', () => ({
  resolveBrainConnection: mockResolveConnection,
  resolveBrainInferenceProvider: mockResolveProvider,
}));

import { brainMaintenanceJob } from '../brain-maintenance';

describe('brainMaintenanceJob', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mockResolveConnection.mockReset();
    mockResolveProvider.mockReset();
  });

  it('does nothing when the Brain provider is disabled', async () => {
    mockResolveProvider.mockResolvedValue(null);
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    await brainMaintenanceJob();

    expect(mockResolveConnection).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('submits the built-in autopilot cycle with the maintenance credential', async () => {
    mockResolveProvider.mockResolvedValue({ providerId: 'openrouter' });
    mockResolveConnection.mockResolvedValue({
      baseUrl: 'http://gbrain.test/',
      token: 'maintenance-token',
    });
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        new Response(
          JSON.stringify({ jsonrpc: '2.0', id: 1, result: { content: [] } }),
          { status: 200 },
        ),
      );

    await brainMaintenanceJob();

    expect(mockResolveConnection).toHaveBeenCalledWith('maintenance');
    expect(fetchSpy).toHaveBeenCalledWith(
      'http://gbrain.test/mcp',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          authorization: 'Bearer maintenance-token',
        }),
      }),
    );
    const request = fetchSpy.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(String(request.body))).toMatchObject({
      params: {
        name: 'submit_job',
        arguments: {
          name: 'autopilot-cycle',
          data: { pull: false },
        },
      },
    });
  });

  it('fails the scheduler job when gbrain rejects the submission', async () => {
    mockResolveProvider.mockResolvedValue({ providerId: 'openrouter' });
    mockResolveConnection.mockResolvedValue({
      baseUrl: 'http://gbrain.test',
      token: 'maintenance-token',
    });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('{"error":"nope"}', { status: 500 }),
    );

    await expect(brainMaintenanceJob()).rejects.toThrow(
      'gbrain maintenance submission failed: 500',
    );
  });
});
