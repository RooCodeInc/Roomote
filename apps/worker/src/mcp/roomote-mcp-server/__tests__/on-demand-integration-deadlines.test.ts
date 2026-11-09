import {
  callOnDemandIntegrationTool,
  findOnDemandIntegrationTools,
} from '../on-demand-integrations.js';

const mocks = vi.hoisted(() => ({
  connect: vi.fn(),
  close: vi.fn(),
  listTools: vi.fn(),
  callTool: vi.fn(),
}));

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: class {
    connect = mocks.connect;
    close = mocks.close;
    listTools = mocks.listTools;
    callTool = mocks.callTool;
  },
}));
vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({
  StreamableHTTPClientTransport: class {},
}));

function aborted(signal: AbortSignal): Promise<never> {
  return new Promise((_resolve, reject) => {
    if (signal.aborted) reject(signal.reason);
    else
      signal.addEventListener('abort', () => reject(signal.reason), {
        once: true,
      });
  });
}
const catalog = (name: string) => ({
  servers: [{ name, displayName: name, url: 'http://127.0.0.1:1/mcp' }],
});
const parse = (result: { content: Array<{ text?: string }> }) =>
  JSON.parse(result.content[0]?.text ?? '{}');

describe('on-demand MCP operation deadlines', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.resetAllMocks();
    mocks.connect.mockResolvedValue(undefined);
    mocks.close.mockResolvedValue(undefined);
    mocks.listTools.mockResolvedValue({
      tools: [{ name: 'read', inputSchema: { type: 'object' } }],
    });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('bounds a stalled initialization, closes it, and retries discovery after repair', async () => {
    mocks.connect.mockImplementationOnce((_transport, options) =>
      aborted(options.signal),
    );
    let settled = false;
    const pending = findOnDemandIntegrationTools(
      catalog('initialization'),
      {},
    ).then((result) => {
      settled = true;
      return result;
    });
    await vi.advanceTimersByTimeAsync(29_999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(parse(await pending)).toMatchObject({
      emptyReason: 'integration_unavailable',
    });
    expect(mocks.close).toHaveBeenCalledOnce();

    const recovered = parse(
      await findOnDemandIntegrationTools(catalog('initialization'), {}),
    );
    expect(recovered.tools).toEqual([
      expect.objectContaining({ name: 'read' }),
    ]);
    expect(mocks.connect).toHaveBeenCalledTimes(2);
    expect(mocks.close).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not grant listing a new full budget after a slow connection', async () => {
    mocks.connect.mockImplementationOnce(
      () => new Promise((resolve) => setTimeout(resolve, 20_000)),
    );
    mocks.listTools.mockImplementationOnce((_params, options) =>
      aborted(options.signal),
    );
    let settled = false;
    const pending = findOnDemandIntegrationTools(
      catalog('combined-budget'),
      {},
    ).then((result) => {
      settled = true;
      return result;
    });
    await vi.advanceTimersByTimeAsync(20_000);
    expect(mocks.listTools).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(9_999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(parse(await pending)).toMatchObject({
      emptyReason: 'integration_unavailable',
    });
    expect(mocks.close).toHaveBeenCalledOnce();
  });

  it('retains the longer tool-call allowance and clears its deadline after success', async () => {
    mocks.callTool.mockImplementationOnce(
      () =>
        new Promise((resolve) =>
          setTimeout(
            () => resolve({ content: [{ type: 'text', text: 'done' }] }),
            90_000,
          ),
        ),
    );
    let settled = false;
    const pending = callOnDemandIntegrationTool(catalog('long-call'), {
      integrationId: 'long-call',
      toolName: 'read',
    }).then((result) => {
      settled = true;
      return result;
    });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(await pending).toMatchObject({ content: [{ text: 'done' }] });
    expect(mocks.close).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('bounds tool-call initialization at its own operation deadline', async () => {
    mocks.connect.mockImplementationOnce((_transport, options) =>
      aborted(options.signal),
    );
    const pending = callOnDemandIntegrationTool(
      catalog('call-initialization'),
      { integrationId: 'call-initialization', toolName: 'read' },
    );
    await vi.advanceTimersByTimeAsync(120_000);
    expect(parse(await pending).error).toContain('timed out');
    expect(mocks.callTool).not.toHaveBeenCalled();
    expect(mocks.close).toHaveBeenCalledOnce();
  });

  it('awaits client cleanup after immediate connection rejection', async () => {
    mocks.connect.mockRejectedValueOnce(new Error('connection rejected'));
    expect(
      parse(await findOnDemandIntegrationTools(catalog('rejected'), {})),
    ).toMatchObject({ emptyReason: 'integration_unavailable' });
    expect(mocks.close).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
});
