import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  RunStatus,
  TaskPayloadKind,
  formatPrBodyAttribution,
} from '@roomote/types';
import type { TaskRun } from '@roomote/db/server';

const {
  mockCreateGitHubToken,
  mockGetDeploymentPrAction,
  mockGetDeploymentGitHubRoomoteMentionEnabled,
  mockGetOctokit,
  mockRepositoriesFindFirst,
  mockEnvironmentsFindFirst,
  mockResolveGitLabToken,
  mockResolveGiteaToken,
  mockResolveGiteaBaseUrl,
  mockBuildGiteaApiBaseUrl,
  mockResolveAdoToken,
  mockResolveAdoBaseUrl,
  mockBuildAdoOrganizationApiBaseUrl,
  mockResolveConfiguredGitHubAppSlugIfConfigured,
  mockResolveLaunchTaskCommitAuthor,
  mockResolveRunCommitAuthor,
} = vi.hoisted(() => ({
  mockCreateGitHubToken: vi.fn(),
  mockGetDeploymentPrAction: vi.fn(),
  mockGetDeploymentGitHubRoomoteMentionEnabled: vi.fn().mockResolvedValue(true),
  mockGetOctokit: vi.fn(),
  mockRepositoriesFindFirst: vi.fn(),
  mockEnvironmentsFindFirst: vi.fn(),
  mockResolveGitLabToken: vi.fn(),
  mockResolveGiteaToken: vi.fn(),
  mockResolveGiteaBaseUrl: vi.fn(),
  mockBuildGiteaApiBaseUrl: vi.fn(),
  mockResolveAdoToken: vi.fn(),
  mockResolveAdoBaseUrl: vi.fn(),
  mockBuildAdoOrganizationApiBaseUrl: vi.fn(),
  mockResolveConfiguredGitHubAppSlugIfConfigured: vi.fn(),
  mockResolveLaunchTaskCommitAuthor: vi.fn(),
  mockResolveRunCommitAuthor: vi.fn(),
}));

vi.mock('@roomote/cloud-agents/server', () => ({
  resolveLaunchTaskCommitAuthor: (...args: unknown[]) =>
    mockResolveLaunchTaskCommitAuthor(...args),
  resolveRunCommitAuthor: (...args: unknown[]) =>
    mockResolveRunCommitAuthor(...args),
}));

vi.mock('@roomote/auth', () => ({
  createGitHubToken: (...args: unknown[]) => mockCreateGitHubToken(...args),
}));

vi.mock('@roomote/github', () => ({
  getOctokit: (...args: unknown[]) => mockGetOctokit(...args),
  resolveConfiguredGitHubAppSlugIfConfigured: (...args: unknown[]) =>
    mockResolveConfiguredGitHubAppSlugIfConfigured(...args),
}));

vi.mock('@roomote/gitlab', () => ({
  resolveGitLabToken: (...args: unknown[]) => mockResolveGitLabToken(...args),
  isGitLabOAuthAccessToken: () => false,
  resolveGitLabBaseUrl: async () => 'https://gitlab.com',
  buildGitLabApiBaseUrl: (baseUrl: string) =>
    `${baseUrl.replace(/\/+$/, '')}/api/v4`,
}));

vi.mock('@roomote/gitea', () => ({
  resolveGiteaToken: (...args: unknown[]) => mockResolveGiteaToken(...args),
  resolveGiteaBaseUrl: (...args: unknown[]) => mockResolveGiteaBaseUrl(...args),
  buildGiteaApiBaseUrl: (...args: unknown[]) =>
    mockBuildGiteaApiBaseUrl(...args),
}));

vi.mock('@roomote/ado', () => ({
  resolveAdoToken: (...args: unknown[]) => mockResolveAdoToken(...args),
  resolveAdoBaseUrl: (...args: unknown[]) => mockResolveAdoBaseUrl(...args),
  buildAdoOrganizationApiBaseUrl: (...args: unknown[]) =>
    mockBuildAdoOrganizationApiBaseUrl(...args),
}));

const { mockTaskPullRequestUpsert, mockTaskRunAssociationUpdate } = vi.hoisted(
  () => ({
    mockTaskPullRequestUpsert: vi.fn(),
    mockTaskRunAssociationUpdate: vi.fn(),
  }),
);

vi.mock('@roomote/db/server', () => ({
  getDeploymentGitHubRoomoteMentionEnabled: (...args: unknown[]) =>
    mockGetDeploymentGitHubRoomoteMentionEnabled(...args),
  getDeploymentPrAction: (...args: unknown[]) =>
    mockGetDeploymentPrAction(...args),
  db: {
    query: {
      repositories: {
        // resolveRepositoryRow queries with findMany; tests queue a single
        // row (or null), adapted here to the list shape it expects.
        findMany: async (...args: unknown[]) => {
          const row = await mockRepositoriesFindFirst(...args);
          return row == null ? [] : [row];
        },
      },
      environments: {
        findFirst: (...args: unknown[]) => mockEnvironmentsFindFirst(...args),
      },
    },
    insert: () => ({
      values: (values: unknown) => ({
        onConflictDoUpdate: () =>
          Promise.resolve(mockTaskPullRequestUpsert(values)),
      }),
    }),
    update: () => ({
      set: (values: unknown) => ({
        where: () => Promise.resolve(mockTaskRunAssociationUpdate(values)),
      }),
    }),
  },
  repositories: {
    sourceControlProvider: 'repositories.sourceControlProvider',
    fullName: 'repositories.fullName',
    isActive: 'repositories.isActive',
  },
  environments: {
    id: 'environments.id',
  },
  taskRuns: {
    id: 'taskRuns.id',
    taskId: 'taskRuns.taskId',
  },
  taskPullRequests: {
    taskId: 'taskPullRequests.taskId',
    prUrl: 'taskPullRequests.prUrl',
  },
  sql: Object.assign(
    (strings: TemplateStringsArray, ...values: unknown[]) => ({
      type: 'sql',
      strings: [...strings],
      values,
    }),
    { raw: (value: string) => ({ type: 'sql.raw', value }) },
  ),
  and: vi.fn((...conditions: unknown[]) => ({ type: 'and', conditions })),
  eq: vi.fn((left: unknown, right: unknown) => ({ type: 'eq', left, right })),
}));

import { createOrUpdateSourceControlPullRequestForTaskRun } from '../source-control-pull-requests';

function makeTaskRun(payload: TaskRun['payload']): TaskRun {
  return {
    id: 123,
    status: RunStatus.Dequeued,
    kind: 'fresh',
    payloadKind: TaskPayloadKind.StandardTask,
    taskId: 'task-123',
    actingUserId: 'user-123',
    payload,
    result: null,
    artifacts: null,
  } as TaskRun;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function attributionBody(
  provenance: string,
  instruction = 'Follow up by mentioning @roomote.',
): string {
  return formatPrBodyAttribution(provenance, instruction);
}

describe('createOrUpdateSourceControlPullRequestForTaskRun', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetDeploymentGitHubRoomoteMentionEnabled.mockResolvedValue(true);
    mockResolveConfiguredGitHubAppSlugIfConfigured.mockResolvedValue(null);
    mockResolveRunCommitAuthor.mockResolvedValue({
      kind: 'roomote',
      displayName: 'Roomote',
      publicDisplayName: null,
      prAssigneeLogin: null,
    });
    mockResolveLaunchTaskCommitAuthor.mockResolvedValue({
      kind: 'roomote',
      displayName: 'Roomote',
      publicDisplayName: null,
      prAssigneeLogin: null,
    });
    mockGetDeploymentPrAction.mockResolvedValue('draft');
    mockEnvironmentsFindFirst.mockResolvedValue(null);
    mockResolveGitLabToken.mockResolvedValue('gitlab-token');
    mockResolveGiteaToken.mockResolvedValue('gitea-token');
    mockResolveGiteaBaseUrl.mockResolvedValue('https://git.example.com');
    mockBuildGiteaApiBaseUrl.mockReturnValue('https://git.example.com/api/v1');
    mockResolveAdoToken.mockResolvedValue('ado-token');
    mockResolveAdoBaseUrl.mockResolvedValue('https://dev.azure.com');
    mockBuildAdoOrganizationApiBaseUrl.mockReturnValue(
      'https://dev.azure.com/acme',
    );
  });

  it('creates a GitLab merge request with the linked public handle', async () => {
    mockGetDeploymentPrAction.mockResolvedValue('create');
    mockRepositoriesFindFirst.mockResolvedValue({
      installationId: null,
      externalRepoId: '101',
      fullName: 'acme/backend',
      host: 'gitlab.com',
      htmlUrl: 'https://gitlab.com/acme/backend',
      private: false,
    });
    mockResolveRunCommitAuthor.mockResolvedValue({
      kind: 'user',
      displayName: 'Private Name',
      publicDisplayName: '@gitlab-user',
      prAssigneeLogin: null,
    });
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse([]))
      .mockResolvedValueOnce(
        jsonResponse({
          iid: 42,
          title: '[Feature] Provider neutral PRs',
          web_url: 'https://gitlab.com/acme/backend/-/merge_requests/42',
          draft: false,
        }),
      );

    const result = await createOrUpdateSourceControlPullRequestForTaskRun({
      taskRun: makeTaskRun({
        repo: 'acme/backend',
        sourceControlProvider: 'gitlab',
        sourceControlHost: 'gitlab.com',
      } as unknown as TaskRun['payload']),
      input: {
        action: 'create_or_update_pull_request',
        repositoryFullName: 'acme/backend',
        sourceBranch: 'codex/provider-neutral',
        targetBranch: 'develop',
        title: '[Feature] Provider neutral PRs',
        body: attributionBody('Opened on behalf of Private Name.'),
        labels: ['roomote'],
        assignees: [],
      },
      fetchImpl,
    });

    expect(result).toMatchObject({
      action: 'created',
      provider: 'gitlab',
      repositoryFullName: 'acme/backend',
      number: 42,
      url: 'https://gitlab.com/acme/backend/-/merge_requests/42',
    });
    // The PR base now persists on the task_pull_requests row itself; runs
    // carry no PR columns.
    expect(mockTaskPullRequestUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: 'task-123',
        prUrl: 'https://gitlab.com/acme/backend/-/merge_requests/42',
        prNumber: 42,
        repository: 'acme/backend',
        status: 'open',
        prBaseRef: 'develop',
      }),
    );
    expect(mockTaskRunAssociationUpdate).not.toHaveBeenCalled();
    expect(fetchImpl).toHaveBeenLastCalledWith(
      'https://gitlab.com/api/v4/projects/101/merge_requests',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'PRIVATE-TOKEN': 'gitlab-token',
        }),
        body: JSON.stringify({
          source_branch: 'codex/provider-neutral',
          target_branch: 'develop',
          remove_source_branch: false,
          title: '[Feature] Provider neutral PRs',
          description: attributionBody('Opened on behalf of @gitlab-user.'),
          labels: 'roomote',
        }),
      }),
    );
    expect(mockResolveRunCommitAuthor).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ actingUserId: 'user-123' }),
      { provider: 'gitlab', host: 'gitlab.com' },
    );
  });

  it('updates an Azure DevOps pull request through the deployment token', async () => {
    mockRepositoriesFindFirst.mockResolvedValue({
      installationId: null,
      externalRepoId: 'repo-uuid',
      fullName: 'acme/Platform/backend',
      htmlUrl: 'https://dev.azure.com/acme/Platform/_git/backend',
    });
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          value: [{ pullRequestId: 7, title: 'Old title', isDraft: true }],
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          pullRequestId: 7,
          title: '[Fix] Provider neutral PRs',
          isDraft: true,
        }),
      );

    const result = await createOrUpdateSourceControlPullRequestForTaskRun({
      taskRun: makeTaskRun({
        repo: 'acme/Platform/backend',
        sourceControlProvider: 'ado',
      }),
      input: {
        action: 'create_or_update_pull_request',
        repositoryFullName: 'acme/Platform/backend',
        sourceBranch: 'codex/provider-neutral',
        targetBranch: 'develop',
        title: '[Fix] Provider neutral PRs',
        body: 'Body',
        labels: [],
        assignees: [],
        sourceControlProvider: 'ado',
      },
      fetchImpl,
    });

    expect(result).toMatchObject({
      action: 'updated',
      provider: 'ado',
      repositoryFullName: 'acme/Platform/backend',
      number: 7,
      url: 'https://dev.azure.com/acme/Platform/_git/backend/pullrequest/7',
    });
    expect(fetchImpl).toHaveBeenLastCalledWith(
      'https://dev.azure.com/acme/Platform/_apis/git/repositories/repo-uuid/pullrequests/7?api-version=7.1',
      expect.objectContaining({
        method: 'PATCH',
        headers: expect.objectContaining({
          Authorization: 'Basic OmFkby10b2tlbg==',
        }),
        body: JSON.stringify({
          title: '[Fix] Provider neutral PRs',
          description: 'Body',
        }),
      }),
    );
    expect(result.draft).toBe(true);
    expect(result.warnings).toEqual([]);
  });
});

describe('platform-managed draft state', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResolveConfiguredGitHubAppSlugIfConfigured.mockResolvedValue(null);
    mockResolveRunCommitAuthor.mockResolvedValue({
      kind: 'roomote',
      displayName: 'Roomote',
      publicDisplayName: null,
      prAssigneeLogin: null,
    });
    mockResolveLaunchTaskCommitAuthor.mockResolvedValue({
      kind: 'roomote',
      displayName: 'Roomote',
      publicDisplayName: null,
      prAssigneeLogin: null,
    });
    mockGetDeploymentPrAction.mockResolvedValue('draft');
    mockEnvironmentsFindFirst.mockResolvedValue(null);
    mockResolveGitLabToken.mockResolvedValue('gitlab-token');
    mockResolveGiteaToken.mockResolvedValue('gitea-token');
    mockResolveGiteaBaseUrl.mockResolvedValue('https://git.example.com');
    mockBuildGiteaApiBaseUrl.mockReturnValue('https://git.example.com/api/v1');
  });

  function makeOctokit({
    existing,
    created,
    updated,
  }: {
    existing?: Record<string, unknown>;
    created?: Record<string, unknown>;
    updated?: Record<string, unknown>;
  }) {
    const octokit = {
      rest: {
        pulls: {
          list: vi.fn().mockResolvedValue({ data: existing ? [existing] : [] }),
          create: vi.fn().mockResolvedValue({ data: created }),
          update: vi.fn().mockResolvedValue({ data: updated ?? existing }),
          get: vi.fn().mockResolvedValue({ data: updated ?? created }),
        },
        issues: {
          addLabels: vi.fn().mockResolvedValue({}),
          addAssignees: vi.fn().mockResolvedValue({}),
          removeAssignees: vi.fn().mockResolvedValue({}),
        },
      },
      graphql: vi.fn().mockResolvedValue({}),
    };
    mockGetOctokit.mockReturnValue(octokit);
    mockCreateGitHubToken.mockResolvedValue('github-token');
    mockRepositoriesFindFirst.mockResolvedValue({
      installationId: 555,
      externalRepoId: null,
      fullName: 'acme/web',
      htmlUrl: 'https://github.com/acme/web',
      private: true,
    });
    return octokit;
  }

  const githubInput = {
    action: 'create_or_update_pull_request' as const,
    repositoryFullName: 'acme/web',
    sourceBranch: 'feature/x',
    targetBranch: 'main',
    title: '[Feature] X',
    body: 'Body',
    labels: [],
    assignees: [],
    sourceControlProvider: 'github' as const,
  };

  it('creates GitHub PRs as drafts from the deployment setting', async () => {
    const octokit = makeOctokit({
      created: {
        number: 9,
        node_id: 'node-9',
        html_url: 'https://github.com/acme/web/pull/9',
        title: '[Feature] X',
        draft: true,
      },
    });

    const result = await createOrUpdateSourceControlPullRequestForTaskRun({
      taskRun: makeTaskRun({ repo: 'acme/web' }),
      input: { ...githubInput },
    });

    expect(octokit.rest.pulls.create).toHaveBeenCalledWith(
      expect.objectContaining({ draft: true }),
    );
    expect(octokit.graphql).not.toHaveBeenCalled();
    expect(result.draft).toBe(true);
    expect(result.warnings).toEqual([]);
  });

  it('uses the @roomote shorthand in attribution when enabled', async () => {
    mockResolveConfiguredGitHubAppSlugIfConfigured.mockResolvedValue(
      'roomote-roomote',
    );
    const octokit = makeOctokit({
      created: {
        number: 12,
        node_id: 'node-12',
        html_url: 'https://github.com/acme/web/pull/12',
        title: '[Feature] X',
        draft: true,
      },
    });

    await createOrUpdateSourceControlPullRequestForTaskRun({
      taskRun: makeTaskRun({ repo: 'acme/web' }),
      input: {
        ...githubInput,
        body: `${attributionBody(
          'Created by Roomote.',
          'Follow up by mentioning @roomote or in [the web UI](https://example.com/task/1).',
        )}\n\n## What changed\n\nDone.`,
      },
    });

    expect(octokit.rest.pulls.create).toHaveBeenCalledWith(
      expect.objectContaining({
        body: `${attributionBody(
          'Created by Roomote.',
          'Follow up by mentioning @roomote or in [the web UI](https://example.com/task/1).',
        )}\n\n## What changed\n\nDone.`,
      }),
    );
  });

  it('uses the configured app slug in attribution after opting out', async () => {
    mockResolveConfiguredGitHubAppSlugIfConfigured.mockResolvedValue(
      'roomote-roomote',
    );
    mockGetDeploymentGitHubRoomoteMentionEnabled.mockResolvedValue(false);
    const octokit = makeOctokit({
      created: {
        number: 12,
        node_id: 'node-12',
        html_url: 'https://github.com/acme/web/pull/12',
        title: '[Feature] X',
        draft: true,
      },
    });

    await createOrUpdateSourceControlPullRequestForTaskRun({
      taskRun: makeTaskRun({ repo: 'acme/web' }),
      input: {
        ...githubInput,
        body: attributionBody(
          'Created by Roomote.',
          'Follow up by mentioning @roomote or in [the web UI](https://example.com/task/1).',
        ),
      },
    });

    expect(octokit.rest.pulls.create).toHaveBeenCalledWith(
      expect.objectContaining({
        body: attributionBody(
          'Created by Roomote.',
          'Follow up by mentioning @roomote-roomote or in [the web UI](https://example.com/task/1).',
        ),
      }),
    );
  });

  it('does not downgrade a correct custom-slug attribution when no slug is configured', async () => {
    mockResolveConfiguredGitHubAppSlugIfConfigured.mockResolvedValue(null);
    const preservedBody =
      '> Created by Roomote. Follow up by mentioning @roomote-roomote or in [the web UI](https://example.com/task/1).\n\n## What changed\n\nDone.';
    const octokit = makeOctokit({
      created: {
        number: 13,
        node_id: 'node-13',
        html_url: 'https://github.com/acme/web/pull/13',
        title: '[Feature] X',
        draft: true,
      },
    });

    await createOrUpdateSourceControlPullRequestForTaskRun({
      taskRun: makeTaskRun({ repo: 'acme/web' }),
      input: {
        ...githubInput,
        body: preservedBody,
      },
    });

    expect(octokit.rest.pulls.create).toHaveBeenCalledWith(
      expect.objectContaining({
        body: preservedBody,
      }),
    );
  });

  it('honors a per-launch prAction override from the task run payload', async () => {
    const octokit = makeOctokit({
      created: {
        number: 10,
        node_id: 'node-10',
        html_url: 'https://github.com/acme/web/pull/10',
        title: '[Feature] X',
        draft: false,
      },
    });

    const result = await createOrUpdateSourceControlPullRequestForTaskRun({
      taskRun: makeTaskRun({ repo: 'acme/web', prAction: 'create' }),
      input: { ...githubInput },
    });

    expect(mockGetDeploymentPrAction).not.toHaveBeenCalled();
    expect(octokit.rest.pulls.create).toHaveBeenCalledWith(
      expect.objectContaining({ draft: false }),
    );
    expect(result.draft).toBe(false);
    expect(result.warnings).toEqual([]);
  });

  it('preserves the existing GitHub draft state on update instead of converting', async () => {
    const existing = {
      number: 11,
      node_id: 'node-11',
      html_url: 'https://github.com/acme/web/pull/11',
      title: 'Old title',
      draft: true,
    };
    const octokit = makeOctokit({
      existing,
      updated: { ...existing, title: '[Feature] X' },
    });

    const result = await createOrUpdateSourceControlPullRequestForTaskRun({
      taskRun: makeTaskRun({ repo: 'acme/web' }),
      input: { ...githubInput },
    });

    expect(octokit.rest.pulls.create).not.toHaveBeenCalled();
    expect(octokit.graphql).not.toHaveBeenCalled();
    expect(result).toMatchObject({ action: 'updated', draft: true });
    expect(result.warnings).toEqual([]);
  });

  it('keeps the Draft: prefix when refreshing a draft GitLab merge request', async () => {
    mockRepositoriesFindFirst.mockResolvedValue({
      installationId: null,
      externalRepoId: '101',
      fullName: 'acme/backend',
      htmlUrl: 'https://gitlab.com/acme/backend',
    });
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse([
          {
            iid: 42,
            title: 'Draft: Old title',
            web_url: 'https://gitlab.com/acme/backend/-/merge_requests/42',
            draft: true,
          },
        ]),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          iid: 42,
          title: 'Draft: [Feature] X',
          web_url: 'https://gitlab.com/acme/backend/-/merge_requests/42',
          draft: true,
        }),
      );

    const result = await createOrUpdateSourceControlPullRequestForTaskRun({
      taskRun: makeTaskRun({
        repo: 'acme/backend',
        sourceControlProvider: 'gitlab',
      }),
      input: {
        ...githubInput,
        repositoryFullName: 'acme/backend',
        sourceControlProvider: 'gitlab' as const,
      },
      fetchImpl,
    });

    const updateBody = JSON.parse(
      (fetchImpl.mock.calls[1]?.[1] as { body: string }).body,
    );
    expect(updateBody.title).toBe('Draft: [Feature] X');
    expect(result.draft).toBe(true);
  });

  it('strips a stale Draft: prefix when the existing GitLab merge request is ready', async () => {
    mockRepositoriesFindFirst.mockResolvedValue({
      installationId: null,
      externalRepoId: '101',
      fullName: 'acme/backend',
      htmlUrl: 'https://gitlab.com/acme/backend',
    });
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse([
          {
            iid: 43,
            title: 'Old title',
            web_url: 'https://gitlab.com/acme/backend/-/merge_requests/43',
            draft: false,
          },
        ]),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          iid: 43,
          title: '[Feature] X',
          web_url: 'https://gitlab.com/acme/backend/-/merge_requests/43',
          draft: false,
        }),
      );

    await createOrUpdateSourceControlPullRequestForTaskRun({
      taskRun: makeTaskRun({
        repo: 'acme/backend',
        sourceControlProvider: 'gitlab',
      }),
      input: {
        ...githubInput,
        repositoryFullName: 'acme/backend',
        sourceControlProvider: 'gitlab' as const,
        title: 'Draft: [Feature] X',
      },
      fetchImpl,
    });

    const updateBody = JSON.parse(
      (fetchImpl.mock.calls[1]?.[1] as { body: string }).body,
    );
    expect(updateBody.title).toBe('[Feature] X');
  });

  it('creates Gitea pull requests with a WIP: title under the draft policy', async () => {
    mockRepositoriesFindFirst.mockResolvedValue({
      installationId: null,
      externalRepoId: '7',
      fullName: 'acme/tools',
      htmlUrl: 'https://git.example.com/acme/tools',
    });
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse([]))
      .mockResolvedValueOnce(
        jsonResponse({
          number: 3,
          title: 'WIP: [Feature] X',
          html_url: 'https://git.example.com/acme/tools/pulls/3',
          draft: false,
        }),
      );

    const result = await createOrUpdateSourceControlPullRequestForTaskRun({
      taskRun: makeTaskRun({
        repo: 'acme/tools',
        sourceControlProvider: 'gitea',
      }),
      input: {
        ...githubInput,
        repositoryFullName: 'acme/tools',
        sourceControlProvider: 'gitea' as const,
      },
      fetchImpl,
    });

    const createBody = JSON.parse(
      (fetchImpl.mock.calls[1]?.[1] as { body: string }).body,
    );
    expect(createBody.title).toBe('WIP: [Feature] X');
    expect(result.draft).toBe(true);
  });
});

describe('optional targetBranch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResolveConfiguredGitHubAppSlugIfConfigured.mockResolvedValue(null);
    mockResolveRunCommitAuthor.mockResolvedValue({
      kind: 'roomote',
      displayName: 'Roomote',
      publicDisplayName: null,
      prAssigneeLogin: null,
    });
    mockResolveLaunchTaskCommitAuthor.mockResolvedValue({
      kind: 'roomote',
      displayName: 'Roomote',
      publicDisplayName: null,
      prAssigneeLogin: null,
    });
    mockGetDeploymentPrAction.mockResolvedValue('draft');
    mockEnvironmentsFindFirst.mockResolvedValue(null);
    mockResolveGitLabToken.mockResolvedValue('gitlab-token');
    mockResolveGiteaToken.mockResolvedValue('gitea-token');
    mockResolveGiteaBaseUrl.mockResolvedValue('https://git.example.com');
    mockBuildGiteaApiBaseUrl.mockReturnValue('https://git.example.com/api/v1');
    mockResolveAdoToken.mockResolvedValue('ado-token');
    mockResolveAdoBaseUrl.mockResolvedValue('https://dev.azure.com');
    mockBuildAdoOrganizationApiBaseUrl.mockReturnValue(
      'https://dev.azure.com/acme',
    );
  });

  const baseInput = {
    action: 'create_or_update_pull_request' as const,
    repositoryFullName: 'acme/web',
    sourceBranch: 'feature/x',
    title: '[Feature] X',
    body: 'Body',
    labels: [],
    assignees: [],
    sourceControlProvider: 'github' as const,
  };

  function makeOctokit({
    list = [],
    created,
    updated,
  }: {
    list?: Array<Record<string, unknown>>;
    created?: Record<string, unknown>;
    updated?: Record<string, unknown>;
  }) {
    const octokit = {
      rest: {
        pulls: {
          list: vi.fn().mockResolvedValue({ data: list }),
          create: vi.fn().mockResolvedValue({ data: created }),
          update: vi.fn().mockResolvedValue({ data: updated ?? list[0] }),
        },
        issues: {
          addLabels: vi.fn().mockResolvedValue({}),
          addAssignees: vi.fn().mockResolvedValue({}),
          removeAssignees: vi.fn().mockResolvedValue({}),
        },
      },
      graphql: vi.fn().mockResolvedValue({}),
    };
    mockGetOctokit.mockReturnValue(octokit);
    mockCreateGitHubToken.mockResolvedValue('github-token');
    mockRepositoriesFindFirst.mockResolvedValue({
      installationId: 555,
      externalRepoId: null,
      fullName: 'acme/web',
      htmlUrl: 'https://github.com/acme/web',
      private: true,
    });
    return octokit;
  }

  it('updates the existing GitHub pull request and keeps its base when targetBranch is omitted', async () => {
    const existing = {
      number: 11,
      node_id: 'node-11',
      html_url: 'https://github.com/acme/web/pull/11',
      title: 'Old title',
      draft: false,
      base: { ref: 'develop' },
    };
    const octokit = makeOctokit({
      list: [existing],
      updated: { ...existing, title: '[Feature] X' },
    });

    const result = await createOrUpdateSourceControlPullRequestForTaskRun({
      taskRun: makeTaskRun({ repo: 'acme/web' }),
      input: { ...baseInput },
    });

    expect(octokit.rest.pulls.list).toHaveBeenCalledWith(
      expect.objectContaining({ head: 'acme:feature/x' }),
    );
    expect(octokit.rest.pulls.list.mock.calls[0]?.[0]).not.toHaveProperty(
      'base',
    );
    expect(octokit.rest.pulls.update).toHaveBeenCalledTimes(1);
    expect(octokit.rest.pulls.update.mock.calls[0]?.[0]).not.toHaveProperty(
      'base',
    );
    expect(octokit.rest.pulls.create).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      action: 'updated',
      number: 11,
      targetBranch: 'develop',
    });
    expect(mockTaskPullRequestUpsert).toHaveBeenCalledWith(
      expect.objectContaining({ prBaseRef: 'develop' }),
    );
  });

  it('scopes the lookup by base and updates without retargeting when targetBranch is explicit', async () => {
    // The base-scoped lookup can only return a pull request that already
    // targets the requested base, so the update never sends base.
    const existing = {
      number: 11,
      node_id: 'node-11',
      html_url: 'https://github.com/acme/web/pull/11',
      title: 'Old title',
      draft: false,
      base: { ref: 'develop' },
    };
    const octokit = makeOctokit({
      list: [existing],
      updated: { ...existing, title: '[Feature] X' },
    });

    const result = await createOrUpdateSourceControlPullRequestForTaskRun({
      taskRun: makeTaskRun({ repo: 'acme/web' }),
      input: { ...baseInput, targetBranch: 'develop' },
    });

    expect(octokit.rest.pulls.list).toHaveBeenCalledWith(
      expect.objectContaining({ base: 'develop' }),
    );
    expect(octokit.rest.pulls.update).toHaveBeenCalledTimes(1);
    expect(octokit.rest.pulls.update.mock.calls[0]?.[0]).not.toHaveProperty(
      'base',
    );
    expect(octokit.rest.pulls.create).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      action: 'updated',
      targetBranch: 'develop',
    });
  });

  it('creates a new GitHub pull request against an explicit base the branch has no open PR for', async () => {
    // A pull request from the same head to a different base is out of scope
    // for the base-filtered lookup, so an explicit targetBranch opens a new
    // pull request against that base instead of retargeting the other one.
    const octokit = makeOctokit({
      list: [],
      created: {
        number: 13,
        node_id: 'node-13',
        html_url: 'https://github.com/acme/web/pull/13',
        title: '[Feature] X',
        draft: true,
        base: { ref: 'develop' },
      },
    });

    const result = await createOrUpdateSourceControlPullRequestForTaskRun({
      taskRun: makeTaskRun({ repo: 'acme/web' }),
      input: { ...baseInput, targetBranch: 'develop' },
    });

    expect(octokit.rest.pulls.list).toHaveBeenCalledWith(
      expect.objectContaining({ base: 'develop' }),
    );
    expect(octokit.rest.pulls.update).not.toHaveBeenCalled();
    expect(octokit.rest.pulls.create).toHaveBeenCalledWith(
      expect.objectContaining({ base: 'develop', head: 'feature/x' }),
    );
    expect(result).toMatchObject({
      action: 'created',
      number: 13,
      targetBranch: 'develop',
    });
  });

  it('assigns a new GitHub pull request to the live acting user instead of the launch owner', async () => {
    const octokit = makeOctokit({
      list: [],
      created: {
        number: 13,
        node_id: 'node-13',
        html_url: 'https://github.com/acme/web/pull/13',
        title: '[Feature] X',
        draft: true,
        base: { ref: 'develop' },
      },
    });
    mockResolveRunCommitAuthor.mockResolvedValue({
      displayName: 'Participant',
      prAssigneeLogin: 'participant',
    });
    mockResolveLaunchTaskCommitAuthor.mockResolvedValueOnce({
      displayName: 'Launch Owner',
      prAssigneeLogin: 'launch-owner',
    });

    await createOrUpdateSourceControlPullRequestForTaskRun({
      taskRun: makeTaskRun({ repo: 'acme/web' }),
      input: {
        ...baseInput,
        targetBranch: 'develop',
        assignees: ['launch-owner'],
      },
    });

    expect(octokit.rest.issues.addAssignees).toHaveBeenCalledWith(
      expect.objectContaining({ assignees: ['participant'] }),
    );
  });

  it('uses the live actor in the body only when creating a pull request', async () => {
    const octokit = makeOctokit({
      list: [],
      created: {
        number: 13,
        node_id: 'node-13',
        html_url: 'https://github.com/acme/web/pull/13',
        title: '[Feature] X',
        draft: true,
        base: { ref: 'develop' },
      },
    });
    mockResolveRunCommitAuthor.mockResolvedValue({
      displayName: 'Participant',
      prAssigneeLogin: null,
    });

    await createOrUpdateSourceControlPullRequestForTaskRun({
      taskRun: makeTaskRun({ repo: 'acme/web' }),
      input: {
        ...baseInput,
        targetBranch: 'develop',
        body: attributionBody('Opened on behalf of Launch Owner.'),
      },
    });

    expect(octokit.rest.pulls.create).toHaveBeenCalledWith(
      expect.objectContaining({
        body: attributionBody('Opened on behalf of Participant.'),
      }),
    );
  });

  it('uses only the linked handle in a public GitHub pull request body', async () => {
    const octokit = makeOctokit({
      list: [],
      created: {
        number: 13,
        node_id: 'node-13',
        html_url: 'https://github.com/acme/web/pull/13',
        title: '[Feature] X',
        draft: true,
        base: { ref: 'develop' },
      },
    });
    mockRepositoriesFindFirst.mockResolvedValue({
      installationId: 555,
      externalRepoId: null,
      fullName: 'acme/web',
      htmlUrl: 'https://github.com/acme/web',
      private: false,
    });
    mockResolveRunCommitAuthor.mockResolvedValue({
      kind: 'user',
      displayName: 'Private Name',
      publicDisplayName: '@participant',
      prAssigneeLogin: null,
    });

    await createOrUpdateSourceControlPullRequestForTaskRun({
      taskRun: makeTaskRun({ repo: 'acme/web' }),
      input: {
        ...baseInput,
        targetBranch: 'develop',
        body: attributionBody('Opened on behalf of Private Name.'),
      },
    });

    expect(octokit.rest.pulls.create).toHaveBeenCalledWith(
      expect.objectContaining({
        body: attributionBody('Opened on behalf of @participant.'),
      }),
    );
  });

  it('scrubs duplicated unmarked attribution in an otherwise marked public body', async () => {
    const octokit = makeOctokit({
      list: [],
      created: {
        number: 13,
        node_id: 'node-13',
        html_url: 'https://github.com/acme/web/pull/13',
        title: '[Feature] X',
        draft: true,
        base: { ref: 'develop' },
      },
    });
    mockRepositoriesFindFirst.mockResolvedValue({
      installationId: 555,
      externalRepoId: null,
      fullName: 'acme/web',
      htmlUrl: 'https://github.com/acme/web',
      private: false,
    });
    mockResolveRunCommitAuthor.mockResolvedValue({
      kind: 'user',
      displayName: 'Private Name',
      publicDisplayName: '@participant',
      prAssigneeLogin: null,
    });

    await createOrUpdateSourceControlPullRequestForTaskRun({
      taskRun: makeTaskRun({ repo: 'acme/web' }),
      input: {
        ...baseInput,
        targetBranch: 'develop',
        body: `${attributionBody('Opened on behalf of Private Name.')}\n\n> Opened on behalf of Duplicated Private Name.`,
      },
    });

    expect(octokit.rest.pulls.create).toHaveBeenCalledWith(
      expect.objectContaining({
        body: `${attributionBody('Opened on behalf of @participant.')}\n\n> Opened on behalf of @participant.`,
      }),
    );
  });

  it('uses generic provenance in a public GitHub pull request without a linked handle', async () => {
    const octokit = makeOctokit({
      list: [],
      created: {
        number: 13,
        node_id: 'node-13',
        html_url: 'https://github.com/acme/web/pull/13',
        title: '[Feature] X',
        draft: true,
        base: { ref: 'develop' },
      },
    });
    mockRepositoriesFindFirst.mockResolvedValue({
      installationId: 555,
      externalRepoId: null,
      fullName: 'acme/web',
      htmlUrl: 'https://github.com/acme/web',
      private: false,
    });
    mockResolveRunCommitAuthor.mockResolvedValue({
      kind: 'user',
      displayName: 'Private Name',
      publicDisplayName: null,
      prAssigneeLogin: null,
    });

    await createOrUpdateSourceControlPullRequestForTaskRun({
      taskRun: makeTaskRun({ repo: 'acme/web' }),
      input: {
        ...baseInput,
        targetBranch: 'develop',
        body: attributionBody('Opened on behalf of Private Name.'),
      },
    });

    expect(octokit.rest.pulls.create).toHaveBeenCalledWith(
      expect.objectContaining({
        body: attributionBody('Created by Roomote.'),
      }),
    );
  });

  it.each(['Slack', 'Discord', 'Telegram', 'Teams'])(
    'scrubs an unmarked public name while preserving %s follow-up instructions',
    async (surface) => {
      const octokit = makeOctokit({
        list: [],
        created: {
          number: 13,
          node_id: 'node-13',
          html_url: 'https://github.com/acme/web/pull/13',
          title: '[Feature] X',
          draft: true,
          base: { ref: 'develop' },
        },
      });
      mockRepositoriesFindFirst.mockResolvedValue({
        installationId: 555,
        externalRepoId: null,
        fullName: 'acme/web',
        htmlUrl: 'https://github.com/acme/web',
        private: false,
      });
      mockResolveRunCommitAuthor.mockResolvedValue({
        kind: 'user',
        displayName: 'Jane R. Doe',
        publicDisplayName: '@participant',
        prAssigneeLogin: null,
      });

      await createOrUpdateSourceControlPullRequestForTaskRun({
        taskRun: makeTaskRun({ repo: 'acme/web' }),
        input: {
          ...baseInput,
          targetBranch: 'develop',
          body: `Preamble\n> Opened on behalf of Jane R. Doe. Follow up by mentioning @roomote, in [the web UI](https://example.com/task/1), or in [${surface}](https://example.com/conversation/1).\n\nDone.`,
        },
      });

      expect(octokit.rest.pulls.create).toHaveBeenCalledWith(
        expect.objectContaining({
          body: `Preamble\n> Opened on behalf of @participant. Follow up by mentioning @roomote, in [the web UI](https://example.com/task/1), or in [${surface}](https://example.com/conversation/1).\n\nDone.`,
        }),
      );
    },
  );

  it('preserves the safe follow-up instruction for a web-launched task', async () => {
    const octokit = makeOctokit({
      list: [],
      created: {
        number: 13,
        node_id: 'node-13',
        html_url: 'https://github.com/acme/web/pull/13',
        title: '[Feature] X',
        draft: true,
        base: { ref: 'develop' },
      },
    });
    mockRepositoriesFindFirst.mockResolvedValue({
      installationId: 555,
      externalRepoId: null,
      fullName: 'acme/web',
      htmlUrl: 'https://github.com/acme/web',
      private: false,
    });
    mockResolveRunCommitAuthor.mockResolvedValue({
      kind: 'user',
      displayName: 'Private Name',
      publicDisplayName: '@participant',
      prAssigneeLogin: null,
    });

    await createOrUpdateSourceControlPullRequestForTaskRun({
      taskRun: makeTaskRun({ repo: 'acme/web' }),
      input: {
        ...baseInput,
        targetBranch: 'develop',
        body: '> Opened on behalf of Private Name. [View the task](https://example.com/task/1) or mention @roomote for follow-up asks.',
      },
    });

    expect(octokit.rest.pulls.create).toHaveBeenCalledWith(
      expect.objectContaining({
        body: '> Opened on behalf of @participant. [View the task](https://example.com/task/1) or mention @roomote for follow-up asks.',
      }),
    );
  });

  it('drops arbitrary text after an unmarked public attribution line', async () => {
    const octokit = makeOctokit({
      list: [],
      created: {
        number: 13,
        node_id: 'node-13',
        html_url: 'https://github.com/acme/web/pull/13',
        title: '[Feature] X',
        draft: true,
        base: { ref: 'develop' },
      },
    });
    mockRepositoriesFindFirst.mockResolvedValue({
      installationId: 555,
      externalRepoId: null,
      fullName: 'acme/web',
      htmlUrl: 'https://github.com/acme/web',
      private: false,
    });
    mockResolveRunCommitAuthor.mockResolvedValue({
      kind: 'user',
      displayName: 'Private Name',
      publicDisplayName: null,
      prAssigneeLogin: null,
    });

    await createOrUpdateSourceControlPullRequestForTaskRun({
      taskRun: makeTaskRun({ repo: 'acme/web' }),
      input: {
        ...baseInput,
        targetBranch: 'develop',
        body: '> Opened on behalf of Private Name. Contact Private Name directly.\n\nDone.',
      },
    });

    expect(octokit.rest.pulls.create).toHaveBeenCalledWith(
      expect.objectContaining({
        body: '> Created by Roomote.\n\nDone.',
      }),
    );
  });

  it('preserves replacement tokens literally in a private marked opener', async () => {
    const existing = {
      number: 11,
      node_id: 'node-11',
      html_url: 'https://github.com/acme/web/pull/11',
      title: 'Old title',
      draft: false,
      base: { ref: 'develop' },
      body: attributionBody('Opened on behalf of Launch $& Owner.'),
    };
    const octokit = makeOctokit({
      list: [existing],
      updated: { ...existing, title: '[Feature] X' },
    });
    mockResolveRunCommitAuthor.mockResolvedValue({
      displayName: 'Participant',
      prAssigneeLogin: null,
    });

    await createOrUpdateSourceControlPullRequestForTaskRun({
      taskRun: makeTaskRun({ repo: 'acme/web' }),
      input: {
        ...baseInput,
        body: attributionBody('Opened on behalf of Participant.'),
      },
    });

    expect(octokit.rest.pulls.update).toHaveBeenCalledWith(
      expect.objectContaining({
        body: attributionBody('Opened on behalf of Launch $& Owner.'),
      }),
    );
  });

  it('does not preserve a private marked name when a public pull request is updated', async () => {
    const existing = {
      number: 11,
      node_id: 'node-11',
      html_url: 'https://github.com/acme/web/pull/11',
      title: 'Old title',
      draft: false,
      base: { ref: 'develop' },
      body: attributionBody('Opened on behalf of Private Name.'),
    };
    const octokit = makeOctokit({
      list: [existing],
      updated: { ...existing, title: '[Feature] X' },
    });
    mockRepositoriesFindFirst.mockResolvedValue({
      installationId: 555,
      externalRepoId: null,
      fullName: 'acme/web',
      htmlUrl: 'https://github.com/acme/web',
      private: false,
    });
    mockResolveRunCommitAuthor.mockResolvedValue({
      kind: 'user',
      displayName: 'Private Name',
      publicDisplayName: '@participant',
      prAssigneeLogin: null,
    });

    await createOrUpdateSourceControlPullRequestForTaskRun({
      taskRun: makeTaskRun({ repo: 'acme/web' }),
      input: {
        ...baseInput,
        body: attributionBody('Opened on behalf of Private Name.'),
      },
    });

    expect(octokit.rest.pulls.update).toHaveBeenCalledWith(
      expect.objectContaining({
        body: attributionBody('Opened on behalf of @participant.'),
      }),
    );
  });

  it('preserves a valid marked handle in existing public attribution', async () => {
    const existing = {
      number: 11,
      node_id: 'node-11',
      html_url: 'https://github.com/acme/web/pull/11',
      title: 'Old title',
      draft: false,
      base: { ref: 'develop' },
      body: attributionBody('Opened on behalf of @launch-owner.'),
    };
    const octokit = makeOctokit({
      list: [existing],
      updated: { ...existing, title: '[Feature] X' },
    });
    mockRepositoriesFindFirst.mockResolvedValue({
      installationId: 555,
      externalRepoId: null,
      fullName: 'acme/web',
      htmlUrl: 'https://github.com/acme/web',
      private: false,
    });
    mockResolveRunCommitAuthor.mockResolvedValue({
      kind: 'user',
      displayName: 'Private Name',
      publicDisplayName: '@participant',
      prAssigneeLogin: null,
    });

    await createOrUpdateSourceControlPullRequestForTaskRun({
      taskRun: makeTaskRun({ repo: 'acme/web' }),
      input: {
        ...baseInput,
        body: attributionBody('Opened on behalf of Private Name.'),
      },
    });

    expect(octokit.rest.pulls.update).toHaveBeenCalledWith(
      expect.objectContaining({
        body: attributionBody('Opened on behalf of @launch-owner.'),
      }),
    );
  });

  it('ignores attribution in an old unmarked public PR', async () => {
    const existing = {
      number: 11,
      node_id: 'node-11',
      html_url: 'https://github.com/acme/web/pull/11',
      title: 'Old title',
      draft: false,
      base: { ref: 'develop' },
      body: '> Opened on behalf of @octocat. Private Name. Follow up by mentioning @roomote.',
    };
    const octokit = makeOctokit({
      list: [existing],
      updated: { ...existing, title: '[Feature] X' },
    });
    mockRepositoriesFindFirst.mockResolvedValue({
      installationId: 555,
      externalRepoId: null,
      fullName: 'acme/web',
      htmlUrl: 'https://github.com/acme/web',
      private: false,
    });
    mockResolveRunCommitAuthor.mockResolvedValue({
      kind: 'user',
      displayName: 'Private Name',
      publicDisplayName: '@participant',
      prAssigneeLogin: null,
    });

    await createOrUpdateSourceControlPullRequestForTaskRun({
      taskRun: makeTaskRun({ repo: 'acme/web' }),
      input: {
        ...baseInput,
        body: attributionBody('Opened on behalf of @participant.'),
      },
    });

    expect(octokit.rest.pulls.update).toHaveBeenCalledWith(
      expect.objectContaining({
        body: attributionBody('Opened on behalf of @participant.'),
      }),
    );
  });

  it('removes the stale launch-owner assignment when updating a pull request', async () => {
    const existing = {
      number: 11,
      node_id: 'node-11',
      html_url: 'https://github.com/acme/web/pull/11',
      title: 'Old title',
      draft: false,
      base: { ref: 'develop' },
      assignees: [{ login: 'launch-owner' }],
    };
    const octokit = makeOctokit({
      list: [existing],
      updated: { ...existing, title: '[Feature] X' },
    });
    mockResolveRunCommitAuthor.mockResolvedValue({
      displayName: 'Participant',
      prAssigneeLogin: 'participant',
    });
    mockResolveLaunchTaskCommitAuthor.mockResolvedValue({
      displayName: 'Launch Owner',
      prAssigneeLogin: 'launch-owner',
    });

    await createOrUpdateSourceControlPullRequestForTaskRun({
      taskRun: makeTaskRun({ repo: 'acme/web' }),
      input: { ...baseInput },
    });

    expect(octokit.rest.issues.removeAssignees).toHaveBeenCalledWith(
      expect.objectContaining({ assignees: ['launch-owner'] }),
    );
    expect(octokit.rest.issues.addAssignees).toHaveBeenCalledWith(
      expect.objectContaining({ assignees: ['participant'] }),
    );
  });

  it('removes the launch-owner assignee when the live actor has no GitHub identity', async () => {
    const octokit = makeOctokit({
      list: [],
      created: {
        number: 13,
        node_id: 'node-13',
        html_url: 'https://github.com/acme/web/pull/13',
        title: '[Feature] X',
        draft: true,
        base: { ref: 'develop' },
      },
    });
    mockResolveRunCommitAuthor.mockResolvedValue({
      displayName: 'Roomote',
      prAssigneeLogin: null,
    });
    mockResolveLaunchTaskCommitAuthor.mockResolvedValueOnce({
      displayName: 'Launch Owner',
      prAssigneeLogin: 'launch-owner',
    });

    await createOrUpdateSourceControlPullRequestForTaskRun({
      taskRun: makeTaskRun({ repo: 'acme/web' }),
      input: {
        ...baseInput,
        targetBranch: 'develop',
        assignees: ['launch-owner'],
      },
    });

    expect(octokit.rest.issues.addAssignees).not.toHaveBeenCalled();
  });

  it('rejects creating a GitHub pull request without targetBranch with actionable guidance', async () => {
    const octokit = makeOctokit({ list: [] });

    const promise = createOrUpdateSourceControlPullRequestForTaskRun({
      taskRun: makeTaskRun({ repo: 'acme/web' }),
      input: { ...baseInput },
    });

    await expect(promise).rejects.toThrow(
      'targetBranch is required to create a pull request: no open pull request was found for source branch "feature/x" in acme/web',
    );
    await expect(promise).rejects.toMatchObject({ httpStatus: 400 });
    expect(octokit.rest.pulls.create).not.toHaveBeenCalled();
    expect(mockTaskPullRequestUpsert).not.toHaveBeenCalled();
  });

  it('refuses to guess between multiple open GitHub pull requests for the source branch', async () => {
    const octokit = makeOctokit({
      list: [
        {
          number: 11,
          node_id: 'node-11',
          html_url: 'https://github.com/acme/web/pull/11',
          title: 'To main',
          base: { ref: 'main' },
        },
        {
          number: 12,
          node_id: 'node-12',
          html_url: 'https://github.com/acme/web/pull/12',
          title: 'To develop',
          base: { ref: 'develop' },
        },
      ],
    });

    const promise = createOrUpdateSourceControlPullRequestForTaskRun({
      taskRun: makeTaskRun({ repo: 'acme/web' }),
      input: { ...baseInput },
    });

    await expect(promise).rejects.toThrow(
      'Multiple open pull requests exist for source branch "feature/x" in acme/web (target branches: main, develop)',
    );
    await expect(promise).rejects.toMatchObject({ httpStatus: 409 });
    expect(octokit.rest.pulls.update).not.toHaveBeenCalled();
    expect(octokit.rest.pulls.create).not.toHaveBeenCalled();
  });

  it('updates the existing GitLab merge request and inherits its target when targetBranch is omitted', async () => {
    mockRepositoriesFindFirst.mockResolvedValue({
      installationId: null,
      externalRepoId: '101',
      fullName: 'acme/backend',
      htmlUrl: 'https://gitlab.com/acme/backend',
    });
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse([
          {
            iid: 42,
            title: 'Old title',
            web_url: 'https://gitlab.com/acme/backend/-/merge_requests/42',
            target_branch: 'develop',
            draft: false,
          },
        ]),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          iid: 42,
          title: '[Feature] X',
          web_url: 'https://gitlab.com/acme/backend/-/merge_requests/42',
          target_branch: 'develop',
          draft: false,
        }),
      );

    const result = await createOrUpdateSourceControlPullRequestForTaskRun({
      taskRun: makeTaskRun({
        repo: 'acme/backend',
        sourceControlProvider: 'gitlab',
      }),
      input: {
        ...baseInput,
        repositoryFullName: 'acme/backend',
        sourceControlProvider: 'gitlab' as const,
      },
      fetchImpl,
    });

    const listUrl = String(fetchImpl.mock.calls[0]?.[0]);
    expect(listUrl).toContain('source_branch=feature%2Fx');
    expect(listUrl).not.toContain('target_branch');
    expect(fetchImpl.mock.calls[1]?.[1]).toMatchObject({ method: 'PUT' });
    expect(result).toMatchObject({
      action: 'updated',
      targetBranch: 'develop',
    });
    expect(mockTaskPullRequestUpsert).toHaveBeenCalledWith(
      expect.objectContaining({ prBaseRef: 'develop' }),
    );
  });

  it('rejects creating a GitLab merge request without targetBranch', async () => {
    mockRepositoriesFindFirst.mockResolvedValue({
      installationId: null,
      externalRepoId: '101',
      fullName: 'acme/backend',
      htmlUrl: 'https://gitlab.com/acme/backend',
    });
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonResponse([]));

    await expect(
      createOrUpdateSourceControlPullRequestForTaskRun({
        taskRun: makeTaskRun({
          repo: 'acme/backend',
          sourceControlProvider: 'gitlab',
        }),
        input: {
          ...baseInput,
          repositoryFullName: 'acme/backend',
          sourceControlProvider: 'gitlab' as const,
        },
        fetchImpl,
      }),
    ).rejects.toThrow('targetBranch is required to create a pull request');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('updates the existing Gitea pull request and inherits its base when targetBranch is omitted', async () => {
    mockRepositoriesFindFirst.mockResolvedValue({
      installationId: null,
      externalRepoId: '7',
      fullName: 'acme/tools',
      htmlUrl: 'https://git.example.com/acme/tools',
    });
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse([
          {
            number: 3,
            title: 'Old title',
            html_url: 'https://git.example.com/acme/tools/pulls/3',
            draft: false,
            head: { ref: 'feature/x' },
            base: { ref: 'develop' },
          },
        ]),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          number: 3,
          title: '[Feature] X',
          html_url: 'https://git.example.com/acme/tools/pulls/3',
          draft: false,
        }),
      );

    const result = await createOrUpdateSourceControlPullRequestForTaskRun({
      taskRun: makeTaskRun({
        repo: 'acme/tools',
        sourceControlProvider: 'gitea',
      }),
      input: {
        ...baseInput,
        repositoryFullName: 'acme/tools',
        sourceControlProvider: 'gitea' as const,
      },
      fetchImpl,
    });

    expect(fetchImpl.mock.calls[1]?.[1]).toMatchObject({ method: 'PATCH' });
    expect(result).toMatchObject({
      action: 'updated',
      targetBranch: 'develop',
    });
  });

  function makeGiteaFillerPulls(count: number) {
    return Array.from({ length: count }, (_, index) => ({
      number: 100 + index,
      title: `Other ${index}`,
      html_url: `https://git.example.com/acme/tools/pulls/${100 + index}`,
      draft: false,
      head: { ref: `other/${index}` },
      base: { ref: 'main' },
    }));
  }

  const giteaMatchingPull = {
    number: 3,
    title: 'Old title',
    html_url: 'https://git.example.com/acme/tools/pulls/3',
    draft: false,
    head: { ref: 'feature/x' },
    base: { ref: 'develop' },
  };

  it('walks Gitea pages until it finds the pull request for the source branch', async () => {
    mockRepositoriesFindFirst.mockResolvedValue({
      installationId: null,
      externalRepoId: '7',
      fullName: 'acme/tools',
      htmlUrl: 'https://git.example.com/acme/tools',
    });
    const fetchImpl = vi
      .fn()
      // Full first page without the branch's pull request must not end the
      // search.
      .mockResolvedValueOnce(jsonResponse(makeGiteaFillerPulls(50)))
      .mockResolvedValueOnce(jsonResponse([giteaMatchingPull]))
      .mockResolvedValueOnce(
        jsonResponse({
          number: 3,
          title: '[Feature] X',
          html_url: 'https://git.example.com/acme/tools/pulls/3',
          draft: false,
        }),
      );

    const result = await createOrUpdateSourceControlPullRequestForTaskRun({
      taskRun: makeTaskRun({
        repo: 'acme/tools',
        sourceControlProvider: 'gitea',
      }),
      input: {
        ...baseInput,
        repositoryFullName: 'acme/tools',
        sourceControlProvider: 'gitea' as const,
      },
      fetchImpl,
    });

    expect(String(fetchImpl.mock.calls[0]?.[0])).toContain('page=1');
    expect(String(fetchImpl.mock.calls[1]?.[0])).toContain('page=2');
    expect(fetchImpl.mock.calls[2]?.[1]).toMatchObject({ method: 'PATCH' });
    expect(result).toMatchObject({
      action: 'updated',
      number: 3,
      targetBranch: 'develop',
    });
  });

  it('stops paging Gitea once an explicit targetBranch match is found', async () => {
    mockRepositoriesFindFirst.mockResolvedValue({
      installationId: null,
      externalRepoId: '7',
      fullName: 'acme/tools',
      htmlUrl: 'https://git.example.com/acme/tools',
    });
    const fetchImpl = vi
      .fn()
      // A full page that already contains the head+base match: no second
      // list request should follow.
      .mockResolvedValueOnce(
        jsonResponse([...makeGiteaFillerPulls(49), giteaMatchingPull]),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          number: 3,
          title: '[Feature] X',
          html_url: 'https://git.example.com/acme/tools/pulls/3',
          draft: false,
        }),
      );

    const result = await createOrUpdateSourceControlPullRequestForTaskRun({
      taskRun: makeTaskRun({
        repo: 'acme/tools',
        sourceControlProvider: 'gitea',
      }),
      input: {
        ...baseInput,
        repositoryFullName: 'acme/tools',
        sourceControlProvider: 'gitea' as const,
        targetBranch: 'develop',
      },
      fetchImpl,
    });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls[1]?.[1]).toMatchObject({ method: 'PATCH' });
    expect(result).toMatchObject({
      action: 'updated',
      number: 3,
      targetBranch: 'develop',
    });
  });

  it('updates the existing Azure DevOps pull request and inherits its target when targetBranch is omitted', async () => {
    mockRepositoriesFindFirst.mockResolvedValue({
      installationId: null,
      externalRepoId: 'repo-uuid',
      fullName: 'acme/Platform/backend',
      htmlUrl: 'https://dev.azure.com/acme/Platform/_git/backend',
    });
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          value: [
            {
              pullRequestId: 7,
              title: 'Old title',
              isDraft: true,
              targetRefName: 'refs/heads/develop',
            },
          ],
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          pullRequestId: 7,
          title: '[Feature] X',
          isDraft: true,
        }),
      );

    const result = await createOrUpdateSourceControlPullRequestForTaskRun({
      taskRun: makeTaskRun({
        repo: 'acme/Platform/backend',
        sourceControlProvider: 'ado',
      }),
      input: {
        ...baseInput,
        repositoryFullName: 'acme/Platform/backend',
        sourceControlProvider: 'ado' as const,
      },
      fetchImpl,
    });

    const listUrl = String(fetchImpl.mock.calls[0]?.[0]);
    expect(listUrl).toContain('searchCriteria.sourceRefName');
    expect(listUrl).not.toContain('targetRefName');
    expect(fetchImpl.mock.calls[1]?.[1]).toMatchObject({ method: 'PATCH' });
    expect(result).toMatchObject({
      action: 'updated',
      targetBranch: 'develop',
    });
    expect(mockTaskPullRequestUpsert).toHaveBeenCalledWith(
      expect.objectContaining({ prBaseRef: 'develop' }),
    );
  });
});
