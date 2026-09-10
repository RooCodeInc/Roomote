import { handleManageSourceControl } from '../source-control.js';
import * as tasksApiClient from '../tasks-api-client.js';
import type {
  RoomoteConfig,
  SourceControlPullRequestResponse,
} from '../types.js';

vi.mock('../tasks-api-client.js');

const config: RoomoteConfig = {
  token: 'test-token',
  platformApiUrl: 'https://test-api.example.com',
};

function pullRequestResponse(
  overrides: Partial<SourceControlPullRequestResponse> = {},
): SourceControlPullRequestResponse {
  return {
    success: true,
    action: 'updated',
    provider: 'github',
    repositoryFullName: 'acme/web',
    number: 12,
    url: 'https://github.com/acme/web/pull/12',
    title: '[Feature] X',
    targetBranch: 'develop',
    draft: false,
    warnings: [],
    ...overrides,
  };
}

describe('handleManageSourceControl create_or_update_pull_request', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('forwards an update without targetBranch so the platform defaults to the existing PR base', async () => {
    vi.mocked(tasksApiClient.manageSourceControl).mockResolvedValueOnce(
      pullRequestResponse(),
    );

    const result = await handleManageSourceControl(
      {
        action: 'create_or_update_pull_request',
        repositoryFullName: 'acme/web',
        sourceBranch: 'feature/x',
        title: '[Feature] X',
        body: 'Body',
        prAttribution: '@participant',
      },
      config,
      'task-1',
    );

    const parsed = JSON.parse(result.content[0]?.text ?? '');
    expect(parsed.success).toBe(true);
    expect(parsed.targetBranch).toBe('develop');
    expect(parsed.message).toBe(
      'Updated pull request acme/web#12: https://github.com/acme/web/pull/12',
    );
    expect(tasksApiClient.manageSourceControl).toHaveBeenCalledWith(
      config,
      'task-1',
      {
        action: 'create_or_update_pull_request',
        repositoryFullName: 'acme/web',
        sourceBranch: 'feature/x',
        targetBranch: undefined,
        title: '[Feature] X',
        body: 'Body',
        prAttribution: '@participant',
        labels: undefined,
        assignees: undefined,
        sourceControlProvider: undefined,
      },
    );
  });

  it('normalizes a blank targetBranch to absent instead of rejecting the call', async () => {
    vi.mocked(tasksApiClient.manageSourceControl).mockResolvedValueOnce(
      pullRequestResponse(),
    );

    const result = await handleManageSourceControl(
      {
        action: 'create_or_update_pull_request',
        repositoryFullName: 'acme/web',
        sourceBranch: 'feature/x',
        targetBranch: '   ',
        title: '[Feature] X',
        body: 'Body',
      },
      config,
      'task-1',
    );

    const parsed = JSON.parse(result.content[0]?.text ?? '');
    expect(parsed.success).toBe(true);
    expect(tasksApiClient.manageSourceControl).toHaveBeenCalledWith(
      config,
      'task-1',
      expect.objectContaining({ targetBranch: undefined }),
    );
  });

  it('passes an explicit targetBranch through trimmed', async () => {
    vi.mocked(tasksApiClient.manageSourceControl).mockResolvedValueOnce(
      pullRequestResponse({ action: 'created', draft: true }),
    );

    const result = await handleManageSourceControl(
      {
        action: 'create_or_update_pull_request',
        repositoryFullName: 'acme/web',
        sourceBranch: 'feature/x',
        targetBranch: ' develop ',
        title: '[Feature] X',
        body: 'Body',
      },
      config,
      'task-1',
    );

    const parsed = JSON.parse(result.content[0]?.text ?? '');
    expect(parsed.success).toBe(true);
    expect(parsed.message).toBe(
      'Created draft pull request acme/web#12: https://github.com/acme/web/pull/12',
    );
    expect(tasksApiClient.manageSourceControl).toHaveBeenCalledWith(
      config,
      'task-1',
      expect.objectContaining({ targetBranch: 'develop' }),
    );
  });

  it('still requires sourceBranch, title, and body', async () => {
    const missingSourceBranch = await handleManageSourceControl(
      {
        action: 'create_or_update_pull_request',
        repositoryFullName: 'acme/web',
        title: '[Feature] X',
        body: 'Body',
      },
      config,
      'task-1',
    );
    expect(
      JSON.parse(missingSourceBranch.content[0]?.text ?? ''),
    ).toMatchObject({
      success: false,
      error: 'sourceBranch is required for create_or_update_pull_request',
    });

    const missingTitle = await handleManageSourceControl(
      {
        action: 'create_or_update_pull_request',
        repositoryFullName: 'acme/web',
        sourceBranch: 'feature/x',
        body: 'Body',
      },
      config,
      'task-1',
    );
    expect(JSON.parse(missingTitle.content[0]?.text ?? '')).toMatchObject({
      success: false,
      error: 'title is required for create_or_update_pull_request',
    });

    const missingBody = await handleManageSourceControl(
      {
        action: 'create_or_update_pull_request',
        repositoryFullName: 'acme/web',
        sourceBranch: 'feature/x',
        title: '[Feature] X',
      },
      config,
      'task-1',
    );
    expect(JSON.parse(missingBody.content[0]?.text ?? '')).toMatchObject({
      success: false,
      error: 'body is required for create_or_update_pull_request',
    });

    expect(tasksApiClient.manageSourceControl).not.toHaveBeenCalled();
  });

  it('surfaces the platform error when creating without targetBranch', async () => {
    vi.mocked(tasksApiClient.manageSourceControl).mockRejectedValueOnce(
      new Error(
        'targetBranch is required to create a pull request: no open pull request was found for source branch "feature/x" in acme/web. Retry with targetBranch set (it is optional only when updating an existing open pull request).',
      ),
    );

    const result = await handleManageSourceControl(
      {
        action: 'create_or_update_pull_request',
        repositoryFullName: 'acme/web',
        sourceBranch: 'feature/x',
        title: '[Feature] X',
        body: 'Body',
      },
      config,
      'task-1',
    );

    const parsed = JSON.parse(result.content[0]?.text ?? '');
    expect(parsed.success).toBe(false);
    expect(parsed.error).toContain(
      'targetBranch is required to create a pull request',
    );
    expect(parsed.error).toContain('Retry with targetBranch set');
  });
});

describe('handleManageSourceControl issue actions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('forwards provider-neutral issue reads to the platform', async () => {
    vi.mocked(tasksApiClient.manageSourceControlIssue).mockResolvedValueOnce({
      success: true,
      action: 'get_issue',
      provider: 'gitlab',
      repositoryFullName: 'acme/web',
      number: 14,
      warnings: [],
      title: 'Broken checkout',
      state: 'open',
    });

    const result = await handleManageSourceControl(
      {
        action: 'get_issue',
        repositoryFullName: 'acme/web',
        issueNumber: 14,
        sourceControlProvider: 'gitlab',
      },
      config,
      'task-1',
    );

    expect(JSON.parse(result.content[0]?.text ?? '')).toMatchObject({
      action: 'get_issue',
      title: 'Broken checkout',
    });
    expect(tasksApiClient.manageSourceControlIssue).toHaveBeenCalledWith(
      config,
      'task-1',
      {
        action: 'get_issue',
        repositoryFullName: 'acme/web',
        issueNumber: 14,
        body: undefined,
        sourceControlProvider: 'gitlab',
      },
    );
  });

  it('requires issueNumber and a body for issue comments', async () => {
    const missingNumber = await handleManageSourceControl(
      {
        action: 'get_issue',
        repositoryFullName: 'acme/web',
      },
      config,
      'task-1',
    );
    const missingBody = await handleManageSourceControl(
      {
        action: 'create_issue_comment',
        repositoryFullName: 'acme/web',
        issueNumber: 14,
      },
      config,
      'task-1',
    );

    expect(JSON.parse(missingNumber.content[0]?.text ?? '')).toMatchObject({
      success: false,
      error: 'issueNumber is required for get_issue',
    });
    expect(JSON.parse(missingBody.content[0]?.text ?? '')).toMatchObject({
      success: false,
      error: 'body is required for create_issue_comment',
    });
    expect(tasksApiClient.manageSourceControlIssue).not.toHaveBeenCalled();
  });

  it('forwards create_pull_request_review_comment anchor fields to the write surface', async () => {
    vi.mocked(tasksApiClient.writeSourceControl).mockResolvedValueOnce({
      success: true,
      action: 'create_pull_request_review_comment',
      provider: 'github',
      repositoryFullName: 'acme/web',
      number: 12,
      threadId: null,
      commentId: '3001',
      url: 'https://github.com/acme/web/pull/12#discussion_r3001',
      applied: true,
      warnings: [],
    } as never);

    const result = await handleManageSourceControl(
      {
        action: 'create_pull_request_review_comment',
        repositoryFullName: 'acme/web',
        prNumber: 12,
        path: '  src/index.ts  ',
        line: 42,
        side: 'RIGHT',
        startLine: 40,
        startSide: 'RIGHT',
        body: 'Missing error handling here.',
      },
      config,
      'task-1',
    );

    expect(JSON.parse(result.content[0]?.text ?? '')).toMatchObject({
      success: true,
      commentId: '3001',
    });
    expect(tasksApiClient.writeSourceControl).toHaveBeenCalledWith(
      config,
      'task-1',
      expect.objectContaining({
        action: 'create_pull_request_review_comment',
        repositoryFullName: 'acme/web',
        prNumber: 12,
        path: 'src/index.ts',
        line: 42,
        side: 'RIGHT',
        startLine: 40,
        startSide: 'RIGHT',
        body: 'Missing error handling here.',
      }),
    );
  });

  it('normalizes and forwards pull request reviewer targets', async () => {
    vi.mocked(tasksApiClient.writeSourceControl).mockResolvedValueOnce({
      success: true,
      action: 'request_pull_request_reviewers',
      provider: 'github',
      repositoryFullName: 'acme/web',
      number: 12,
      applied: true,
      warnings: [],
    } as never);

    const result = await handleManageSourceControl(
      {
        action: 'request_pull_request_reviewers',
        repositoryFullName: 'acme/web',
        prNumber: 12,
        reviewers: [' alice ', ''],
        teamReviewers: [' platform '],
      },
      config,
      'task-1',
    );

    expect(JSON.parse(result.content[0]?.text ?? '')).toMatchObject({
      success: true,
      applied: true,
    });
    expect(tasksApiClient.writeSourceControl).toHaveBeenCalledWith(
      config,
      'task-1',
      expect.objectContaining({
        action: 'request_pull_request_reviewers',
        repositoryFullName: 'acme/web',
        prNumber: 12,
        reviewers: ['alice'],
        teamReviewers: ['platform'],
      }),
    );
  });

  it('requires at least one pull request reviewer target', async () => {
    const result = await handleManageSourceControl(
      {
        action: 'request_pull_request_reviewers',
        repositoryFullName: 'acme/web',
        prNumber: 12,
        reviewers: ['  '],
      },
      config,
      'task-1',
    );

    expect(JSON.parse(result.content[0]?.text ?? '')).toMatchObject({
      success: false,
      error:
        'reviewers or teamReviewers is required for request_pull_request_reviewers',
    });
    expect(tasksApiClient.writeSourceControl).not.toHaveBeenCalled();
  });

  it('requires path, a positive integer line, and a body for inline review comments', async () => {
    const missingPath = await handleManageSourceControl(
      {
        action: 'create_pull_request_review_comment',
        repositoryFullName: 'acme/web',
        prNumber: 12,
        line: 42,
        body: 'Missing error handling here.',
      },
      config,
      'task-1',
    );
    const badLine = await handleManageSourceControl(
      {
        action: 'create_pull_request_review_comment',
        repositoryFullName: 'acme/web',
        prNumber: 12,
        path: 'src/index.ts',
        line: 0,
        body: 'Missing error handling here.',
      },
      config,
      'task-1',
    );
    const missingBody = await handleManageSourceControl(
      {
        action: 'create_pull_request_review_comment',
        repositoryFullName: 'acme/web',
        prNumber: 12,
        path: 'src/index.ts',
        line: 42,
      },
      config,
      'task-1',
    );

    expect(JSON.parse(missingPath.content[0]?.text ?? '')).toMatchObject({
      success: false,
      error: 'path is required for create_pull_request_review_comment',
    });
    expect(JSON.parse(badLine.content[0]?.text ?? '')).toMatchObject({
      success: false,
      error:
        'line is required for create_pull_request_review_comment and must be a positive integer',
    });
    expect(JSON.parse(missingBody.content[0]?.text ?? '')).toMatchObject({
      success: false,
      error: 'body is required for create_pull_request_review_comment',
    });
    expect(tasksApiClient.writeSourceControl).not.toHaveBeenCalled();
  });

  it('requires and forwards a review id and reason for review dismissal', async () => {
    vi.mocked(tasksApiClient.writeSourceControl).mockResolvedValueOnce({
      success: true,
      action: 'dismiss_pull_request_review',
      provider: 'github',
      repositoryFullName: 'acme/web',
      number: 12,
      commentId: '900',
      applied: true,
      warnings: [],
    } as never);

    const result = await handleManageSourceControl(
      {
        action: 'dismiss_pull_request_review',
        repositoryFullName: 'acme/web',
        prNumber: 12,
        reviewId: ' 900 ',
        body: 'Requested changes have been addressed.',
      },
      config,
      'task-1',
    );

    expect(JSON.parse(result.content[0]?.text ?? '')).toMatchObject({
      success: true,
      action: 'dismiss_pull_request_review',
    });
    expect(tasksApiClient.writeSourceControl).toHaveBeenCalledWith(
      config,
      'task-1',
      expect.objectContaining({
        action: 'dismiss_pull_request_review',
        reviewId: '900',
        body: 'Requested changes have been addressed.',
      }),
    );

    vi.clearAllMocks();
    const missingReviewId = await handleManageSourceControl(
      {
        action: 'dismiss_pull_request_review',
        repositoryFullName: 'acme/web',
        prNumber: 12,
        body: 'Requested changes have been addressed.',
      },
      config,
      'task-1',
    );

    expect(JSON.parse(missingReviewId.content[0]?.text ?? '')).toMatchObject({
      success: false,
      error: 'reviewId is required for dismiss_pull_request_review',
    });
    expect(tasksApiClient.writeSourceControl).not.toHaveBeenCalled();
  });
});
