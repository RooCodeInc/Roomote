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

  it('returns compact model-facing results from the unchanged API payload', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          automations: [
            {
              id: 'automation-1',
              name: 'Daily report',
              prompt: 'Large private prompt',
              enabled: true,
              scheduleMode: 'daily',
              cronExpression: null,
              model: null,
              environmentId: 'environment-1',
              target: {},
              createdByUser: { email: 'admin@example.com' },
              lastError: 'previous failure',
            },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    const result = await handleManageCustomAutomations(
      { action: 'list' },
      config,
    );

    expect(JSON.parse(result.content[0]?.text ?? '{}')).toEqual({
      automations: [
        {
          id: 'automation-1',
          name: 'Daily report',
          enabled: true,
          schedule: 'daily',
          model: null,
          environmentId: 'environment-1',
          lastError: 'previous failure',
        },
      ],
    });
  });

  it('inspects one prompt without returning unrelated automation fields', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          automation: {
            id: 'automation-1',
            name: 'Daily report',
            prompt: 'Inspect this stored prompt.',
            enabled: true,
            lastError: 'previous failure',
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    const result = await handleManageCustomAutomations(
      { action: 'inspect', automationId: 'automation/1' },
      config,
    );

    const [url, request] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      'https://api.example.com/api/mcp/custom-automations/automation%2F1',
    );
    expect(request.method).toBe('GET');
    expect(request.body).toBeUndefined();
    expect(JSON.parse(result.content[0]?.text ?? '{}')).toEqual({
      automation: {
        id: 'automation-1',
        name: 'Daily report',
        prompt: 'Inspect this stored prompt.',
      },
    });
  });

  it('preserves structured schedule clarification on an ambiguous write', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          status: 'ambiguous',
          clarification: 'What time should this run?',
          resolution: {
            status: 'ambiguous',
            cronExpression: null,
            summary: 'Needs a time',
            clarification: 'What time should this run?',
            timeZone: 'UTC',
            nextRunAt: null,
            inferenceUsage: { tokens: 500 },
          },
        }),
        { status: 409, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    const result = await handleManageCustomAutomations(
      {
        action: 'create',
        name: 'Daily report',
        prompt: 'Report.',
        schedule: 'daily-ish',
        environmentId: 'environment-1',
      },
      config,
    );

    expect(JSON.parse(result.content[0]?.text ?? '{}')).toEqual({
      success: false,
      error: 'Custom automation request failed (409)',
      httpStatus: 409,
      resolutionStatus: 'ambiguous',
      clarification: 'What time should this run?',
      resolution: {
        status: 'ambiguous',
        cronExpression: null,
        summary: 'Needs a time',
        clarification: 'What time should this run?',
        timeZone: 'UTC',
        nextRunAt: null,
      },
    });
  });

  it('preserves failed run-now outcomes and errors', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          outcome: 'failed',
          error: 'Automation is disabled.',
          automation: { prompt: 'large' },
        }),
        { status: 400, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    const result = await handleManageCustomAutomations(
      { action: 'run_now', automationId: 'automation-1' },
      config,
    );

    expect(JSON.parse(result.content[0]?.text ?? '{}')).toEqual({
      success: false,
      error: 'Automation is disabled.',
      httpStatus: 400,
      outcome: 'failed',
    });
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
