import { Hono } from 'hono';

import type { Variables } from '../../../types';
import type { McpAuth } from '../../mcp/middleware';
import { manageSourceControl } from '../manageSourceControl';

const {
  mockAssertTaskRunTokenTargetExists,
  mockClaimLatestUserMessageForReplyQuote,
  mockFindTaskRunForSourceControlMutation,
  mockManageSourceControlIssueForTaskRun,
  mockWriteSourceControlPullRequestForTaskRun,
} = vi.hoisted(() => ({
  mockAssertTaskRunTokenTargetExists: vi.fn(),
  mockClaimLatestUserMessageForReplyQuote: vi.fn(),
  mockFindTaskRunForSourceControlMutation: vi.fn(),
  mockManageSourceControlIssueForTaskRun: vi.fn(),
  mockWriteSourceControlPullRequestForTaskRun: vi.fn(),
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
  writeSourceControlPullRequestForTaskRun:
    mockWriteSourceControlPullRequestForTaskRun,
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

  it('dispatches create_pull_request_review_comment to the write surface without reply quoting', async () => {
    mockWriteSourceControlPullRequestForTaskRun.mockResolvedValue({
      success: true,
      action: 'create_pull_request_review_comment',
      provider: 'github',
      repositoryFullName: 'acme/frontend',
      number: 55,
      threadId: null,
      commentId: '3001',
      url: 'https://github.com/acme/frontend/pull/55#discussion_r3001',
      applied: true,
      warnings: [],
    });

    const response = await createApp().request('/task-1/source_control', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        action: 'create_pull_request_review_comment',
        repositoryFullName: 'acme/frontend',
        prNumber: 55,
        path: 'src/index.ts',
        line: 42,
        side: 'RIGHT',
        body: 'Missing error handling here.',
      }),
    });

    expect(response.status).toBe(200);
    // Inline review findings are agent-authored, so the pending user message
    // must never be quoted above them even on a GitHub target with a body.
    expect(mockClaimLatestUserMessageForReplyQuote).not.toHaveBeenCalled();
    expect(mockWriteSourceControlPullRequestForTaskRun).toHaveBeenCalledWith({
      taskRun: expect.objectContaining({ id: 123 }),
      input: expect.objectContaining({
        action: 'create_pull_request_review_comment',
        path: 'src/index.ts',
        line: 42,
        side: 'RIGHT',
        body: 'Missing error handling here.',
      }),
    });
  });

  it('defers unmapped provider errors until after repository scope validation', async () => {
    mockManageSourceControlIssueForTaskRun.mockRejectedValueOnce(
      new Error(
        "Repository other/repo is outside this task's source-control scope.",
      ),
    );

    const response = await createApp().request('/task-1/source_control', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        action: 'get_issue',
        repositoryFullName: 'other/repo',
        issueNumber: 42,
      }),
    });

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      error:
        "Repository other/repo is outside this task's source-control scope.",
    });
    expect(mockManageSourceControlIssueForTaskRun).toHaveBeenCalled();
  });
});
