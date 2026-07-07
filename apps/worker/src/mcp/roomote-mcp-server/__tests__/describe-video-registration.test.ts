describe('roomote MCP describe_video registration', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv };
    delete process.env.ROOMOTE_CLOUD_TOKEN;
    delete process.env.ROOMOTE_TASK_ID;
    delete process.env.ROOMOTE_TASK_TYPE;
    delete process.env.ROOMOTE_SLACK_CHANNEL;
    delete process.env.ROOMOTE_SLACK_THREAD_TS;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.restoreAllMocks();
  });

  it('registers describe_video on server initialization', async () => {
    const { roomoteMcpServer } = await import('../index.js');
    const registeredTools = (
      roomoteMcpServer as unknown as {
        _registeredTools: Record<
          string,
          {
            description?: string;
            annotations?: { readOnlyHint?: boolean };
          }
        >;
      }
    )._registeredTools;

    expect(registeredTools.describe_video).toBeDefined();
    expect(registeredTools.describe_video?.annotations?.readOnlyHint).toBe(
      true,
    );
    expect(registeredTools.describe_video?.description).toContain(
      'Describe the contents of a video file',
    );
  });
});
