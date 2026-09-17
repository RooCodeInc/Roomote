import { expect, it, vi } from 'vitest';

import { mergeAdoPullRequest } from '../api';

it('completes an Azure DevOps PR at the expected head without policy bypass or branch deletion', async () => {
  const response = {
    pullRequestId: 7,
    status: 'completed',
    repository: { id: 'repository-id' },
    lastMergeSourceCommit: { commitId: 'a'.repeat(40) },
  };
  const fetchImpl = vi.fn<typeof fetch>(async () => Response.json(response));
  await expect(
    mergeAdoPullRequest({
      repositoryId: 'repository-id',
      pullRequestNumber: 7,
      expectedHeadSha: 'a'.repeat(40),
      mergeStrategy: 'squash',
      token: 'token',
      organizationApiBaseUrl: 'https://dev.azure.com/org',
      fetchImpl,
    }),
  ).resolves.toEqual(response);
  expect(fetchImpl).toHaveBeenCalledWith(
    'https://dev.azure.com/org/_apis/git/repositories/repository-id/pullRequests/7?api-version=7.1',
    expect.objectContaining({
      method: 'PATCH',
      body: JSON.stringify({
        status: 'completed',
        lastMergeSourceCommit: { commitId: 'a'.repeat(40) },
        completionOptions: {
          bypassPolicy: false,
          deleteSourceBranch: false,
          mergeStrategy: 'squash',
        },
      }),
    }),
  );
});
