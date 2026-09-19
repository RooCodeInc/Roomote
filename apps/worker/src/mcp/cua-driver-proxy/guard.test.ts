import { guardCuaDriverRequest, readHumanControlState } from './guard';

describe('readHumanControlState', () => {
  it.each([
    [true, 'human'],
    [false, 'agent'],
  ] as const)('maps human_driving=%s to %s', async (humanDriving, expected) => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({ human_driving: humanDriving }),
    });

    await expect(
      readHumanControlState('http://127.0.0.1:6080/metrics', fetchImpl),
    ).resolves.toBe(expected);
  });

  it('fails closed when metrics cannot be read', async () => {
    await expect(
      readHumanControlState(
        'http://127.0.0.1:6080/metrics',
        vi.fn().mockRejectedValue(new Error('offline')),
      ),
    ).resolves.toBe('unavailable');
  });
});

describe('guardCuaDriverRequest', () => {
  const request = (name: string) =>
    JSON.stringify({
      jsonrpc: '2.0',
      id: 7,
      method: 'tools/call',
      params: { name, arguments: {} },
    });

  it('keeps observation tools available while a person drives', async () => {
    await expect(
      guardCuaDriverRequest(request('get_browser_state'), async () => 'human'),
    ).resolves.toEqual({ forward: true });
  });

  it('refuses input tools while a person drives', async () => {
    const result = await guardCuaDriverRequest(
      request('browser_click'),
      async () => 'human',
    );

    expect(result.forward).toBe(false);
    if (!result.forward) {
      expect(JSON.parse(result.response)).toMatchObject({
        id: 7,
        result: { isError: true },
      });
      expect(result.response).toContain('person is using the Shared Desktop');
    }
  });

  it('fails closed for new mutation tools when handoff state is unavailable', async () => {
    const result = await guardCuaDriverRequest(
      request('future_input_tool'),
      async () => 'unavailable',
    );

    expect(result.forward).toBe(false);
    if (!result.forward) {
      expect(result.response).toContain('handoff state is unavailable');
    }
  });

  it('forwards input after control returns to the agent', async () => {
    await expect(
      guardCuaDriverRequest(request('browser_type'), async () => 'agent'),
    ).resolves.toEqual({ forward: true });
  });
});
