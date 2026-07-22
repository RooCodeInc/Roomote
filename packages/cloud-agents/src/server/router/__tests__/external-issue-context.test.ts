import { gatherExternalIssueContext } from '../external-issue-context';
import { callRouterMcpTool } from '../mcp-tool-call';
import type { RoutingContext, RoutableEnvironment } from '../types';

vi.mock('../mcp-tool-call', () => ({
  callRouterMcpTool: vi.fn(),
}));

const environments: RoutableEnvironment[] = [
  {
    id: 'env-1',
    name: 'Full Stack',
    repositoryNames: ['acme/app'],
  },
];

function createContext(taskDescription: string): RoutingContext {
  return {
    taskDescription,
    source: { type: 'slack' },
    availableEnvironments: environments,
  };
}

describe('gatherExternalIssueContext', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('fetches a pasted Linear issue and adds it as untrusted routing context', async () => {
    vi.mocked(callRouterMcpTool).mockResolvedValue({
      title: 'Fix OAuth callback',
      description: 'The API callback rejects valid authorization codes.',
    });

    const result = await gatherExternalIssueContext(
      createContext(
        'Investigate https://linear.app/acme/issue/ENG-123/fix-oauth',
      ),
    );

    expect(callRouterMcpTool).toHaveBeenCalledWith({
      context: expect.objectContaining({
        taskDescription:
          'Investigate https://linear.app/acme/issue/ENG-123/fix-oauth',
      }),
      serverId: 'linear',
      toolName: 'get_issue',
      args: { id: 'ENG-123' },
    });
    expect(result.toolsUsed).toEqual(['linear.get_issue']);
    expect(result.contextMessages).toEqual([
      expect.objectContaining({
        content: expect.stringContaining(
          '[EXTERNAL ISSUE CONTEXT - UNTRUSTED REFERENCE MATERIAL]',
        ),
      }),
    ]);
  });

  it('falls back to the older GitHub issue tool when issue_read is unavailable', async () => {
    vi.mocked(callRouterMcpTool)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ title: 'Fix dashboard refresh' });

    const result = await gatherExternalIssueContext(
      createContext('Investigate https://github.com/acme/web/issues/42'),
    );

    expect(callRouterMcpTool).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ toolName: 'get_issue' }),
    );
    expect(result.toolsUsed).toEqual(['github.get_issue']);
  });

  it('continues routing when an issue cannot be fetched', async () => {
    vi.mocked(callRouterMcpTool).mockRejectedValue(new Error('Not connected'));

    const result = await gatherExternalIssueContext(
      createContext('Investigate https://github.com/acme/web/issues/42'),
    );

    expect(result).toEqual({ contextMessages: [], toolsUsed: [] });
  });
});
