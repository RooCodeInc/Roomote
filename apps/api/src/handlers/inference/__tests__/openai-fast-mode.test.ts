import {
  inspectOpenAiFastModeRequest,
  observeOpenAiFastModeResponse,
} from '../openai-fast-mode';

describe('OpenAI Fast mode gateway validation', () => {
  it('accepts Fast only for a confirmed direct OpenAI Responses model route', async () => {
    const supported = await inspectOpenAiFastModeRequest(
      new Request('https://roomote.test/v1/responses', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'gpt-6-astra',
          service_tier: 'priority',
        }),
      }),
    );

    expect(supported).toMatchObject({
      status: 'fast',
      context: {
        modelId: 'openai/gpt-6-astra',
        capabilityId: 'openai:openai-api-key:gpt-6-astra:responses',
      },
    });

    const unsupported = await inspectOpenAiFastModeRequest(
      new Request('https://roomote.test/v1/responses', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'gpt-5.4-pro',
          service_tier: 'priority',
        }),
      }),
    );

    expect(unsupported.status).toBe('unsupported');
  });

  it('leaves Standard requests outside Fast validation', async () => {
    await expect(
      inspectOpenAiFastModeRequest(
        new Request('https://roomote.test/v1/responses', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            model: 'gpt-6-astra',
            service_tier: 'default',
          }),
        }),
      ),
    ).resolves.toEqual({ status: 'not-fast' });
  });

  it('reports an OpenAI API downgrade while preserving the streamed response', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const event =
      'event: response.completed\ndata: {"type":"response.completed","response":{"model":"gpt-6-astra","service_tier":"default"}}\n\n';
    const upstream = new Response(event, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    });
    const response = observeOpenAiFastModeResponse(
      upstream,
      {
        modelId: 'openai/gpt-6-astra',
        capabilityId: 'openai:openai-api-key:gpt-6-astra:responses',
      },
      { requestId: 'request-1', runId: 42 },
    );

    await expect(response.text()).resolves.toBe(event);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining(
        '[Inference Gateway:openai] Fast mode request was served as Standard',
      ),
    );
    warn.mockRestore();
  });
});
