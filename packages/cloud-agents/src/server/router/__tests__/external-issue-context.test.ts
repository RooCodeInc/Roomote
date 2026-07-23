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

  it('strips every trailing punctuation character from a pasted issue URL', async () => {
    vi.mocked(callRouterMcpTool).mockResolvedValue({
      title: 'Fix dashboard refresh',
    });

    await gatherExternalIssueContext(
      createContext('Investigate https://github.com/acme/web/issues/42...'),
    );

    expect(callRouterMcpTool).toHaveBeenCalledWith(
      expect.objectContaining({
        args: expect.objectContaining({ issue_number: 42 }),
      }),
    );
  });

  it('continues routing when an issue cannot be fetched', async () => {
    vi.mocked(callRouterMcpTool).mockRejectedValue(new Error('Not connected'));

    const result = await gatherExternalIssueContext(
      createContext('Investigate https://github.com/acme/web/issues/42'),
    );

    expect(result).toEqual({ contextMessages: [], toolsUsed: [] });
  });

  it('resolves a bare Linear identifier from the precheck', async () => {
    vi.mocked(callRouterMcpTool).mockResolvedValue({
      title: 'Fix OAuth callback',
    });

    const result = await gatherExternalIssueContext(
      createContext('Check ENG-512 when you get a chance'),
      'ENG-512',
    );

    expect(callRouterMcpTool).toHaveBeenCalledWith(
      expect.objectContaining({
        serverId: 'linear',
        toolName: 'get_issue',
        args: { id: 'ENG-512' },
      }),
    );
    expect(result.contextMessages[0]?.content).toContain('[ENG-512]');
  });

  it('fans a bare issue number out across the configured repositories', async () => {
    vi.mocked(callRouterMcpTool).mockResolvedValue({ title: 'Some issue' });

    const result = await gatherExternalIssueContext(
      createContextWithRepos('Check issue #234', [
        'acme/web',
        'acme/api',
      ]),
      '#234',
    );

    expect(callRouterMcpTool).toHaveBeenCalledWith(
      expect.objectContaining({
        serverId: 'github',
        args: expect.objectContaining({ repo: 'web', issue_number: 234 }),
      }),
    );
    expect(callRouterMcpTool).toHaveBeenCalledWith(
      expect.objectContaining({
        serverId: 'github',
        args: expect.objectContaining({ repo: 'api', issue_number: 234 }),
      }),
    );
    expect(result.contextMessages[0]?.content).toContain('[acme/web#234]');
    expect(result.contextMessages[0]?.content).toContain('[acme/api#234]');
  });

  it('only resolves a repo-qualified reference against configured repositories', async () => {
    vi.mocked(callRouterMcpTool).mockResolvedValue({ title: 'Some issue' });

    const configured = await gatherExternalIssueContext(
      createContextWithRepos('Check acme/web#42', ['acme/web']),
      'acme/web#42',
    );

    expect(configured.toolsUsed).toEqual(['github.issue_read']);

    vi.clearAllMocks();
    vi.mocked(callRouterMcpTool).mockResolvedValue({ title: 'Some issue' });

    const unconfigured = await gatherExternalIssueContext(
      createContextWithRepos('Check evil/repo#1', ['acme/web']),
      'evil/repo#1',
    );

    expect(callRouterMcpTool).not.toHaveBeenCalled();
    expect(unconfigured).toEqual({ contextMessages: [], toolsUsed: [] });
  });

  it('fails open on a bare number when too many repositories are configured', async () => {
    const result = await gatherExternalIssueContext(
      createContextWithRepos('Check issue #234', [
        'acme/web',
        'acme/api',
        'acme/mobile',
        'acme/infra',
      ]),
      '#234',
    );

    expect(callRouterMcpTool).not.toHaveBeenCalled();
    expect(result).toEqual({ contextMessages: [], toolsUsed: [] });
  });

  it('prefers pasted issue URLs over the precheck reference', async () => {
    vi.mocked(callRouterMcpTool).mockResolvedValue({ title: 'Some issue' });

    await gatherExternalIssueContext(
      createContext('Investigate https://github.com/acme/web/issues/42'),
      'ENG-512',
    );

    expect(callRouterMcpTool).not.toHaveBeenCalledWith(
      expect.objectContaining({ serverId: 'linear' }),
    );
  });
});

function createContextWithRepos(
  taskDescription: string,
  repositoryNames: string[],
): RoutingContext {
  return {
    taskDescription,
    source: { type: 'slack' },
    availableEnvironments: [
      { id: 'env-1', name: 'Full Stack', repositoryNames },
    ],
  };
}
