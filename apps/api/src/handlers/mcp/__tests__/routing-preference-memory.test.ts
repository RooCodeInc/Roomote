const mocks = vi.hoisted(() => ({
  callMcpTool: vi.fn(),
  resolveBrainConnection: vi.fn(),
}));

vi.mock('@roomote/cloud-agents/server', () => ({
  callMcpTool: mocks.callMcpTool,
}));

vi.mock('@roomote/sdk/server', () => ({
  resolveBrainConnection: mocks.resolveBrainConnection,
}));

import {
  getRoutingPreferenceMemory,
  recordRoutingPreferenceMemory,
} from '../routing-preference-memory';

describe('routing preference Brain memory', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveBrainConnection.mockResolvedValue({
      baseUrl: 'http://brain.test',
      token: 'brain-token',
    });
  });

  it('reads a preference from an exact Brain page', async () => {
    mocks.callMcpTool.mockResolvedValue({
      frontmatter: {
        environment_id: 'env-api',
        accepted_count: 2,
        correction_count: 1,
        last_selected_at: '2026-08-16T12:00:00.000Z',
      },
    });

    await expect(getRoutingPreferenceMemory('user-1')).resolves.toEqual({
      environmentId: 'env-api',
      acceptedCount: 2,
      correctionCount: 1,
      lastSelectedAt: '2026-08-16T12:00:00.000Z',
    });
    expect(mocks.callMcpTool).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: 'get_page',
        args: { slug: 'routing/preferences/users/dXNlci0x' },
      }),
    );
  });

  it('reinforces the same environment and writes the page through Brain ingestion', async () => {
    mocks.callMcpTool
      .mockResolvedValueOnce({
        frontmatter: {
          environment_id: 'env-api',
          accepted_count: 2,
          correction_count: 1,
          last_selected_at: '2026-08-16T12:00:00.000Z',
        },
      })
      .mockResolvedValueOnce({ ok: true });

    const result = await recordRoutingPreferenceMemory({
      userId: 'user-1',
      environmentId: 'env-api',
      signal: 'corrected',
    });

    expect(result).toMatchObject({
      environmentId: 'env-api',
      acceptedCount: 2,
      correctionCount: 2,
    });
    expect(mocks.callMcpTool).toHaveBeenLastCalledWith(
      expect.objectContaining({
        toolName: 'put_page',
        args: expect.objectContaining({
          slug: 'routing/preferences/users/dXNlci0x',
          content: expect.stringContaining('correction_count: 2'),
        }),
      }),
    );
  });

  it('fails open when Brain is not configured', async () => {
    mocks.resolveBrainConnection.mockResolvedValue(null);

    await expect(getRoutingPreferenceMemory('user-1')).resolves.toBeNull();
    await expect(
      recordRoutingPreferenceMemory({
        userId: 'user-1',
        environmentId: 'env-api',
        signal: 'accepted',
      }),
    ).resolves.toBeNull();
    expect(mocks.callMcpTool).not.toHaveBeenCalled();
  });
});
