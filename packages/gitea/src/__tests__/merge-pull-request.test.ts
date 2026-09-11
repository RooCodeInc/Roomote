import { expect, it, vi } from 'vitest';

import { mergeGiteaPullRequest } from '../api';

it('binds a Gitea merge to the expected head and requested method', async () => {
  const fetchImpl = vi.fn<typeof fetch>(
    async () => new Response(null, { status: 204 }),
  );
  await mergeGiteaPullRequest({
    repositoryFullName: 'owner/repo',
    pullRequestNumber: 7,
    expectedHeadSha: 'a'.repeat(40),
    mergeMethod: 'squash',
    token: 'token',
    baseUrl: 'https://gitea.example',
    fetchImpl,
  });
  expect(fetchImpl).toHaveBeenCalledWith(
    'https://gitea.example/api/v1/repos/owner/repo/pulls/7/merge',
    expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({
        Do: 'squash',
        head_commit_id: 'a'.repeat(40),
      }),
    }),
  );
});
