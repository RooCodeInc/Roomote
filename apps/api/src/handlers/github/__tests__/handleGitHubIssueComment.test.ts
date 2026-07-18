const {
  mockGetGitHubAutomationTargets,
  mockGetInstallationOctokit,
  mockEnqueueTask,
  mockGetTaskUrl,
  mockDbSelect,
} = vi.hoisted(() => ({
  mockGetGitHubAutomationTargets: vi.fn(),
  mockGetInstallationOctokit: vi.fn(),
  mockEnqueueTask: vi.fn(),
  mockGetTaskUrl: vi.fn(),
  mockDbSelect: vi.fn(),
}));

// Prompt-framing fakes use distinctive markers so tests can assert the
// handler routes each piece of text through the right builder; the real
// escaping/wrapping behavior is unit-tested in @roomote/cloud-agents.
vi.mock('@roomote/cloud-agents/server', () => ({
  enqueueTask: mockEnqueueTask,
  getTaskUrl: mockGetTaskUrl,
  buildMentionRequestBlock: (text: string) =>
    `<mention_request>${text}</mention_request>`,
  buildUntrustedExternalContentBlock: ({
    source,
    text,
  }: {
    source: string;
    text: string;
  }) =>
    `<untrusted_external_content source="${source}">${text}</untrusted_external_content>`,
  buildUntrustedContentPolicy: () => '<untrusted_content_policy/>',
  escapeTaskContextText: (value: string) => value,
}));

vi.mock('@roomote/db/server', () => ({
  db: {
    select: mockDbSelect,
  },
  environmentRepositoryMappings: {
    environmentId: 'environmentId',
    repositoryId: 'repositoryId',
  },
  eq: vi.fn((...args: unknown[]) => args),
  asc: vi.fn((value: unknown) => value),
}));

vi.mock('@roomote/github', () => ({
  Schemas: {
    isRoomoteGitHubLogin: vi.fn(() => false),
  },
  getEffectiveGitHubAppSlug: vi.fn(() => 'roomote'),
  getInstallationOctokit: mockGetInstallationOctokit,
}));

vi.mock('../getGitHubAutomationTargets', () => ({
  getGitHubAutomationTargets: mockGetGitHubAutomationTargets,
}));

vi.mock('@roomote/env', () => ({
  Env: {
    R_GITHUB_APP_SLUG: 'roomote',
    R_APP_URL: 'https://app.roomote.dev',
  },
}));

import { TaskPayloadKind } from '@roomote/types';

import { handleGitHubIssueComment } from '../handleGitHubIssueComment';
import type { WebhookIssueCommentCreated } from '../types';

function makePayload(
  overrides: Partial<WebhookIssueCommentCreated> = {},
): WebhookIssueCommentCreated {
  return {
    action: 'created',
    installation: { id: 123 },
    repository: {
      id: 456,
      full_name: 'acme/api',
      name: 'api',
      owner: { login: 'acme' },
      private: true,
      html_url: 'https://github.com/acme/api',
      default_branch: 'main',
    },
    sender: {
      id: 99,
      login: 'alice',
      type: 'User',
    },
    issue: {
      number: 42,
      title: 'Ship it',
      body: 'Please fix the bug',
      html_url: 'https://github.com/acme/api/issues/42',
      user: { login: 'bob' },
    },
    comment: {
      id: 777,
      body: '@roomote please take a look',
      user: { login: 'alice' },
    },
    ...overrides,
  } as WebhookIssueCommentCreated;
}

describe('handleGitHubIssueComment', () => {
  const createComment = vi.fn().mockResolvedValue({});

  beforeEach(() => {
    vi.clearAllMocks();

    mockGetInstallationOctokit.mockResolvedValue({
      rest: {
        issues: {
          createComment,
        },
      },
    });
    mockGetTaskUrl.mockReturnValue('https://app.roomote.dev/task/task-1');
    mockEnqueueTask.mockResolvedValue({ id: 11, taskId: 'task-1' });
    mockGetGitHubAutomationTargets.mockResolvedValue({
      status: 'ok',
      targets: [
        {
          id: 'github:pr_conflict_resolve:repo-1',
          workflow: 'pr_conflict_resolve',
          settings: null,
          repo: { id: 'repo-1', fullName: 'acme/api' },
          collaborators: [],
          repositoryIds: ['repo-1'],
          properties: {
            userId: 'user-1',
            githubLogin: 'alice',
            githubUserId: 99,
          },
        },
      ],
    });
    mockDbSelect.mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          orderBy: vi.fn().mockResolvedValue([{ environmentId: 'env-1' }]),
        }),
      }),
    });
  });

  it('starts a standard task for a plain issue @mention', async () => {
    const result = await handleGitHubIssueComment(makePayload());

    expect(result).toEqual({
      status: 'ok',
      metadata: { ids: [11] },
    });
    expect(mockEnqueueTask).toHaveBeenCalledWith(
      expect.objectContaining({
        task: expect.objectContaining({
          type: TaskPayloadKind.StandardTask,
          payload: expect.objectContaining({
            repo: 'acme/api',
            environmentId: 'env-1',
            selectedRepositories: ['acme/api'],
            linkedWorkItems: [
              expect.objectContaining({
                provider: 'github',
                identifier: '42',
                repository: 'acme/api',
              }),
            ],
          }),
        }),
        surface: 'github',
        workflow: 'standard',
        initiator: { kind: 'user', userId: 'user-1' },
      }),
    );
    expect(createComment).toHaveBeenCalledWith(
      expect.objectContaining({
        issue_number: 42,
        body: expect.stringContaining('See task'),
      }),
    );
  });

  it('frames the mention comment and issue body as delimited untrusted content', async () => {
    const result = await handleGitHubIssueComment(makePayload());

    expect(result.status).toBe('ok');
    const description = mockEnqueueTask.mock.calls[0]?.[0].task.payload
      .description as string;
    expect(description).toContain(
      '<mention_request>@roomote please take a look</mention_request>',
    );
    expect(description).toContain(
      '<untrusted_external_content source="github_issue_body">Please fix the bug</untrusted_external_content>',
    );
    expect(description).toContain('authored by @bob');
    expect(description).toContain('<untrusted_content_policy/>');
  });

  it('does not duplicate the issue body when the mention is the issue body itself', async () => {
    const issueBody = 'Take a look at this crash please, @roomote';
    const base = makePayload();
    // `issues.opened` shape: no comment object, the issue body is the mention.
    const result = await handleGitHubIssueComment({
      installation: base.installation,
      repository: base.repository,
      sender: base.sender,
      issue: {
        number: 42,
        title: 'Ship it',
        body: issueBody,
        html_url: 'https://github.com/acme/api/issues/42',
        user: { login: 'alice' },
      },
      mentionBody: issueBody,
    });

    expect(result.status).toBe('ok');
    const description = mockEnqueueTask.mock.calls[0]?.[0].task.payload
      .description as string;
    expect(description).toContain(
      `<mention_request>${issueBody}</mention_request>`,
    );
    expect(description).not.toContain('source="github_issue_body"');
    expect(description).toContain('<untrusted_content_policy/>');
  });

  it('prompts the commenter to link GitHub before starting work', async () => {
    mockGetGitHubAutomationTargets.mockResolvedValue({
      status: 'error',
      code: 'account_link_required',
      message: 'GitHub user alice is not linked',
    });

    const result = await handleGitHubIssueComment(makePayload());

    expect(result).toEqual({ status: 'ok', message: 'account_link_required' });
    expect(mockEnqueueTask).not.toHaveBeenCalled();
    expect(createComment).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.stringContaining('GitHub account linked'),
      }),
    );
  });

  it('requires an environment mapped to the repository', async () => {
    mockDbSelect.mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          orderBy: vi.fn().mockResolvedValue([]),
        }),
      }),
    });

    const result = await handleGitHubIssueComment(makePayload());

    expect(result).toEqual({ status: 'ok', message: 'environment_required' });
    expect(mockEnqueueTask).not.toHaveBeenCalled();
    expect(createComment).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.stringContaining('no Roomote environment is mapped'),
      }),
    );
  });

  it('ignores comments without a bot mention', async () => {
    const result = await handleGitHubIssueComment(
      makePayload({
        comment: {
          id: 777,
          body: 'just a regular comment',
          user: { login: 'alice' },
        } as WebhookIssueCommentCreated['comment'],
      }),
    );

    expect(result).toEqual({ status: 'ok', message: 'no_mention' });
    expect(mockEnqueueTask).not.toHaveBeenCalled();
    expect(createComment).not.toHaveBeenCalled();
  });

  it('starts a task from an issue body mention when no comment is present', async () => {
    const result = await handleGitHubIssueComment({
      installation: { id: 123 } as WebhookIssueCommentCreated['installation'],
      repository: makePayload().repository,
      sender: makePayload().sender,
      issue: {
        ...makePayload().issue,
        body: '@roomote please investigate this',
      },
      mentionBody: '@roomote please investigate this',
    });

    expect(result).toEqual({
      status: 'ok',
      metadata: { ids: [11] },
    });
    expect(mockEnqueueTask).toHaveBeenCalled();
  });
});
