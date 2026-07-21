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
});
