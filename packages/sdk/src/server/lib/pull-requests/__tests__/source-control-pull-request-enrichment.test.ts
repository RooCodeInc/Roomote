import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockCreateGitHubToken,
  mockGetOctokit,
  mockResolveGitLabToken,
  mockResolveGiteaToken,
  mockResolveGiteaBaseUrl,
  mockBuildGiteaApiBaseUrl,
  mockResolveAdoToken,
  mockResolveAdoBaseUrl,
  mockBuildAdoOrganizationApiBaseUrl,
} = vi.hoisted(() => ({
  mockCreateGitHubToken: vi.fn(),
  mockGetOctokit: vi.fn(),
  mockResolveGitLabToken: vi.fn(),
  mockResolveGiteaToken: vi.fn(),
  mockResolveGiteaBaseUrl: vi.fn(),
  mockBuildGiteaApiBaseUrl: vi.fn(),
  mockResolveAdoToken: vi.fn(),
  mockResolveAdoBaseUrl: vi.fn(),
  mockBuildAdoOrganizationApiBaseUrl: vi.fn(),
}));

vi.mock('@roomote/auth', () => ({
  createGitHubToken: (...args: unknown[]) => mockCreateGitHubToken(...args),
}));
vi.mock('@roomote/github', () => ({
  getOctokit: (...args: unknown[]) => mockGetOctokit(...args),
}));
vi.mock('@roomote/gitlab', () => ({
  resolveGitLabToken: (...args: unknown[]) => mockResolveGitLabToken(...args),
  isGitLabOAuthAccessToken: (token: string) => token === 'oauth-token',
  resolveGitLabBaseUrl: async () => 'https://gitlab.com',
  buildGitLabApiBaseUrl: (baseUrl: string) =>
    `${baseUrl.replace(/\/+$/, '')}/api/v4`,
}));
vi.mock('@roomote/bitbucket', () => ({
  resolveBitbucketAuth: async () => ({
    token: 'bitbucket-token',
    username: 'bb-bot',
    baseUrl: 'https://bitbucket.org',
    apiBaseUrl: 'https://api.bitbucket.org/2.0',
    authScheme: 'bearer',
  }),
  buildBitbucketApiBaseUrl: () => 'https://api.bitbucket.org/2.0',
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
vi.mock('@roomote/db/server', () => ({
  db: { query: { repositories: { findMany: async () => [] } } },
  repositories: {},
  and: vi.fn(),
  eq: vi.fn(),
}));

import {
  readSourceControlPullRequestEnrichment,
  totalPullRequestLineChanges,
} from '../source-control-pull-request-enrichment';
import type { RepositoryRow } from '../source-control-pull-request-shared';

function repositoryRow(overrides: Partial<RepositoryRow>): RepositoryRow {
  return {
    id: 'repo-1',
    sourceControlProvider: 'gitlab',
    host: null,
    installationId: null,
    externalRepoId: null,
    fullName: 'acme/backend',
    htmlUrl: 'https://example.com/acme/backend',
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function requestedUrls(fetchImpl: ReturnType<typeof vi.fn>): string[] {
  return fetchImpl.mock.calls.map((call) => String(call[0]));
}

beforeEach(() => {
  vi.clearAllMocks();
  mockCreateGitHubToken.mockResolvedValue('github-token');
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

describe('readSourceControlPullRequestEnrichment', () => {
  it('reads GitHub files and reviews through the installation client', async () => {
    const listFiles = vi.fn().mockResolvedValue({
      data: [
        {
          filename: 'apps/web/page.tsx',
          status: 'modified',
          additions: 4,
          deletions: 1,
        },
        {
          filename: 'packages/db/schema.ts',
          status: 'added',
          additions: 20,
          deletions: 0,
        },
      ],
    });
    const listReviews = vi.fn().mockResolvedValue({
      data: [
        { state: 'APPROVED', user: { login: 'grace' } },
        { state: 'CHANGES_REQUESTED', user: { login: 'ada' } },
        { state: 'COMMENTED', user: { login: 'linus' } },
        { state: 'SOMETHING_NEW', user: { login: 'x' } },
      ],
    });
    mockGetOctokit.mockReturnValue({
      rest: { pulls: { listFiles, listReviews } },
    });

    const result = await readSourceControlPullRequestEnrichment({
      repository: repositoryRow({
        sourceControlProvider: 'github',
        installationId: 'inst-1',
        fullName: 'acme/widgets',
      }),
      provider: 'github',
      prNumber: 42,
    });

    expect(mockCreateGitHubToken).toHaveBeenCalledWith({
      type: 'installationId',
      installationId: 'inst-1',
    });
    expect(listFiles).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: 'acme',
        repo: 'widgets',
        pull_number: 42,
      }),
    );
    expect(result.files.map((file) => file.path)).toEqual([
      'apps/web/page.tsx',
      'packages/db/schema.ts',
    ]);
    expect(totalPullRequestLineChanges(result.files)).toEqual({
      additions: 24,
      deletions: 1,
    });
    expect(result.reviews).toEqual([
      { login: 'grace', state: 'approved' },
      { login: 'ada', state: 'changes_requested' },
      { login: 'linus', state: 'commented' },
    ]);
    expect(result.filesTruncated).toBe(false);
  });

  it('reads GitLab diffs (paths only) and approvals', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse([
          { new_path: 'src/a.ts', old_path: 'src/a.ts' },
          { new_path: 'src/b.ts', old_path: 'src/b.ts', new_file: true },
          {
            old_path: 'src/gone.ts',
            new_path: 'src/gone.ts',
            deleted_file: true,
          },
        ]),
      )
      .mockResolvedValueOnce(
        jsonResponse({ approved_by: [{ user: { username: 'grace' } }] }),
      );

    const result = await readSourceControlPullRequestEnrichment({
      repository: repositoryRow({ externalRepoId: '101' }),
      provider: 'gitlab',
      prNumber: 7,
      fetchImpl,
    });

    expect(requestedUrls(fetchImpl)).toEqual([
      'https://gitlab.com/api/v4/projects/101/merge_requests/7/diffs?per_page=100&page=1',
      'https://gitlab.com/api/v4/projects/101/merge_requests/7/approvals',
    ]);
    expect(result.files.map((file) => [file.path, file.status])).toEqual([
      ['src/a.ts', 'modified'],
      ['src/b.ts', 'added'],
      ['src/gone.ts', 'removed'],
    ]);
    // GitLab's diff listing carries no line counts.
    expect(totalPullRequestLineChanges(result.files)).toEqual({
      additions: null,
      deletions: null,
    });
    expect(result.reviews).toEqual([{ login: 'grace', state: 'approved' }]);
  });

  it('reads Gitea files and review states', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse([
          {
            filename: 'main.go',
            status: 'modified',
            additions: 3,
            deletions: 2,
          },
        ]),
      )
      .mockResolvedValueOnce(
        jsonResponse([
          { state: 'APPROVED', user: { login: 'grace' } },
          { state: 'REQUEST_CHANGES', user: { login: 'ada' } },
          { state: 'REQUEST_REVIEW', user: { login: 'bot' } },
        ]),
      );

    const result = await readSourceControlPullRequestEnrichment({
      repository: repositoryRow({
        sourceControlProvider: 'gitea',
        fullName: 'acme/svc',
      }),
      provider: 'gitea',
      prNumber: 3,
      fetchImpl,
    });

    expect(requestedUrls(fetchImpl)).toEqual([
      'https://git.example.com/api/v1/repos/acme/svc/pulls/3/files?limit=100&page=1',
      'https://git.example.com/api/v1/repos/acme/svc/pulls/3/reviews',
    ]);
    expect(result.files).toEqual([
      { path: 'main.go', status: 'modified', additions: 3, deletions: 2 },
    ]);
    expect(result.reviews).toEqual([
      { login: 'grace', state: 'approved' },
      { login: 'ada', state: 'changes_requested' },
    ]);
  });

  it('reads Bitbucket diffstat pages and reviewer participants', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          values: [
            {
              status: 'modified',
              lines_added: 5,
              lines_removed: 1,
              new: { path: 'lib/x.rb' },
            },
          ],
          next: 'https://api.bitbucket.org/2.0/repositories/ws/repo/pullrequests/9/diffstat?page=2',
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          values: [
            {
              status: 'removed',
              lines_added: 0,
              lines_removed: 8,
              old: { path: 'lib/y.rb' },
            },
          ],
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          participants: [
            { role: 'REVIEWER', approved: true, user: { nickname: 'grace' } },
            {
              role: 'REVIEWER',
              approved: false,
              state: 'changes_requested',
              user: { display_name: 'Ada L' },
            },
            {
              role: 'PARTICIPANT',
              approved: true,
              user: { nickname: 'lurker' },
            },
          ],
        }),
      );

    const result = await readSourceControlPullRequestEnrichment({
      repository: repositoryRow({
        sourceControlProvider: 'bitbucket',
        fullName: 'ws/repo',
      }),
      provider: 'bitbucket',
      prNumber: 9,
      fetchImpl,
    });

    expect(requestedUrls(fetchImpl)[0]).toBe(
      'https://api.bitbucket.org/2.0/repositories/ws/repo/pullrequests/9/diffstat?pagelen=100',
    );
    expect(requestedUrls(fetchImpl)[1]).toContain('page=2');
    expect(result.files.map((file) => file.path)).toEqual([
      'lib/x.rb',
      'lib/y.rb',
    ]);
    expect(totalPullRequestLineChanges(result.files)).toEqual({
      additions: 5,
      deletions: 9,
    });
    expect(result.reviews).toEqual([
      { login: 'grace', state: 'approved' },
      { login: 'Ada L', state: 'changes_requested' },
    ]);
  });

  it('reads Azure DevOps latest-iteration changes and reviewer votes', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({ value: [{ id: 1 }, { id: 3 }, { id: 2 }] }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          changeEntries: [
            { changeType: 'edit', item: { path: '/src/app.cs' } },
            { changeType: 'add', item: { path: '/src/new.cs' } },
          ],
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          reviewers: [
            { displayName: 'Grace', uniqueName: 'grace@acme.com', vote: 10 },
            { displayName: 'Ada', uniqueName: 'ada@acme.com', vote: -5 },
            { displayName: 'Nobody', uniqueName: 'n@acme.com', vote: 0 },
          ],
        }),
      );

    const result = await readSourceControlPullRequestEnrichment({
      repository: repositoryRow({
        sourceControlProvider: 'ado',
        fullName: 'acme/proj/repo',
        externalRepoId: 'repo-guid',
      }),
      provider: 'ado',
      prNumber: 11,
      fetchImpl,
    });

    const urls = requestedUrls(fetchImpl);
    expect(urls[0]).toContain('/pullrequests/11/iterations?api-version=7.1');
    expect(urls[1]).toContain('/pullrequests/11/iterations/3/changes?');
    expect(result.files.map((file) => [file.path, file.status])).toEqual([
      ['src/app.cs', 'edit'],
      ['src/new.cs', 'add'],
    ]);
    expect(result.reviews).toEqual([
      { login: 'grace@acme.com', state: 'approved' },
      { login: 'ada@acme.com', state: 'changes_requested' },
    ]);
  });
});
