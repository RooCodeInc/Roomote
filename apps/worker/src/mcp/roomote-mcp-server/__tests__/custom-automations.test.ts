import { handleManageCustomAutomations } from '../custom-automations.js';
import type { RoomoteConfig } from '../types.js';

const config: RoomoteConfig = {
  token: 'test-token',
  platformApiUrl: 'https://api.example.com',
};

describe('handleManageCustomAutomations', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ automation: { id: 'automation-1' } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
  });

  afterEach(() => vi.unstubAllGlobals());

  it('lists enabled automation model choices', async () => {
    await handleManageCustomAutomations({ action: 'list_models' }, config);

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, request] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      'https://api.example.com/api/mcp/custom-automations/models',
    );
    expect(request.method).toBe('GET');
  });

  it('sends only fields supplied for an update', async () => {
    await handleManageCustomAutomations(
      {
        action: 'update',
        automationId: 'automation-1',
        prompt: 'Updated prompt',
      },
      config,
    );

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, request] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      'https://api.example.com/api/mcp/custom-automations/automation-1',
    );
    expect(request.method).toBe('PATCH');
    expect(JSON.parse(request.body as string)).toEqual({
      prompt: 'Updated prompt',
    });
  });

  it('does not re-enable an automation when enabled is omitted', async () => {
    await handleManageCustomAutomations(
      {
        action: 'update',
        automationId: 'automation-1',
        schedule: '0 9 * * 1-5',
      },
      config,
    );

    const [, request] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(request.body as string)).toEqual({
      schedule: '0 9 * * 1-5',
    });
  });

  it('sends an explicit null provider to clear the report destination', async () => {
    await handleManageCustomAutomations(
      {
        action: 'update',
        automationId: 'automation-1',
        targetProvider: null,
      },
      config,
    );

    const [, request] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(request.body as string)).toEqual({
      targetProvider: null,
    });
  });

  it('sends the direct-message destination mode', async () => {
    await handleManageCustomAutomations(
      {
        action: 'update',
        automationId: 'automation-1',
        targetProvider: 'slack',
        targetMode: 'direct_message',
      },
      config,
    );

    const [, request] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(request.body as string)).toEqual({
      targetProvider: 'slack',
      targetMode: 'direct_message',
    });
  });

  it('still requires all create fields and defaults enabled to true', async () => {
    const missing = await handleManageCustomAutomations(
      { action: 'create', name: 'Incomplete' },
      config,
    );
    expect(JSON.parse(missing.content[0]?.text ?? '{}')).toMatchObject({
      success: false,
      error: 'prompt is required',
    });
    expect(fetchMock).not.toHaveBeenCalled();

    await handleManageCustomAutomations(
      {
        action: 'create',
        name: 'Daily scan',
        prompt: 'Scan the repository.',
        schedule: 'daily',
        environmentId: 'environment-1',
      },
      config,
    );
    const [, request] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(request.body as string)).toMatchObject({ enabled: true });
  });
});
