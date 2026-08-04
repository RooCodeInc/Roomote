import { Hono } from 'hono';

import type { Variables } from '../../../types';
import type { McpAuth } from '../../mcp/middleware';
import { manageSourceControl } from '../manageSourceControl';

const {
  mockAssertTaskRunTokenTargetExists,
  mockClaimLatestUserMessageForReplyQuote,
  mockFindTaskRunForSourceControlMutation,
  mockManageSourceControlIssueForTaskRun,
} = vi.hoisted(() => ({
  mockAssertTaskRunTokenTargetExists: vi.fn(),
  mockClaimLatestUserMessageForReplyQuote: vi.fn(),
  mockFindTaskRunForSourceControlMutation: vi.fn(),
  mockManageSourceControlIssueForTaskRun: vi.fn(),
}));

vi.mock('@roomote/communication/messages', () => ({
  claimLatestUserMessageForReplyQuote: mockClaimLatestUserMessageForReplyQuote,
  completeClaimedLatestUserMessageForReplyQuote: vi.fn(),
  restoreClaimedLatestUserMessageForReplyQuote: vi.fn(),
}));

vi.mock('@roomote/sdk/server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@roomote/sdk/server')>()),
  findTaskRunForSourceControlMutation: mockFindTaskRunForSourceControlMutation,
  manageSourceControlIssueForTaskRun: mockManageSourceControlIssueForTaskRun,
}));

vi.mock('../../mcp/proxy-utils', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../mcp/proxy-utils')>()),
  assertTaskRunTokenTargetExists: mockAssertTaskRunTokenTargetExists,
}));

function createApp() {
  const app = new Hono<{
    Variables: Variables & { mcpAuth: McpAuth };
  }>();
  const mcpAuth = {
    authContext: {
      runId: 123,
      userId: 'user-1',
      principal: 'user',
      tokenType: 'run',
      version: 1,
    },
    userId: 'user-1',
  } as McpAuth;

  app.use('*', async (c, next) => {
    c.set('mcpAuth', mcpAuth);
    await next();
  });
  app.post('/:taskId/source_control', manageSourceControl);

  return app;
}

describe('manageSourceControl', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAssertTaskRunTokenTargetExists.mockResolvedValue(undefined);
    mockFindTaskRunForSourceControlMutation.mockResolvedValue({
      id: 123,
      payload: {
        repo: 'acme/frontend',
        selectedRepositories: ['acme/frontend', 'acme/backend'],
        sourceControlProvider: 'github',
        repositoryProviders: { 'acme/backend': 'gitlab' },
      },
    });
    mockManageSourceControlIssueForTaskRun.mockResolvedValue({
      success: true,
      action: 'create_issue_comment',
      provider: 'gitlab',
      repositoryFullName: 'acme/backend',
      number: 1082,
      commentId: '9',
      warnings: [],
    });
  });

  it('does not apply GitHub reply quoting to a GitLab target in a GitHub-primary task', async () => {
    const response = await createApp().request('/task-1/source_control', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        action: 'create_issue_comment',
        repositoryFullName: 'acme/backend',
        issueNumber: 1082,
        body: 'Fixed in the latest branch.',
      }),
    });

    expect(response.status).toBe(200);
    expect(mockClaimLatestUserMessageForReplyQuote).not.toHaveBeenCalled();
    expect(mockManageSourceControlIssueForTaskRun).toHaveBeenCalledWith({
      taskRun: expect.objectContaining({ id: 123 }),
      input: expect.objectContaining({
        repositoryFullName: 'acme/backend',
        body: 'Fixed in the latest branch.',
      }),
    });
  });
});
