vi.mock('@roomote/sdk/client', () => ({
  sdk: {
    cloudJobs: {
      update: vi.fn().mockResolvedValue(undefined),
    },
  },
}));

import {
  CloudTaskType,
  CONFLICT_RESOLUTION_SUMMARY_RESULT_KEY,
} from '@roomote/types';
import { type CloudJob, sdk } from '@roomote/sdk/client';

import { githubPrConflictResolveCallbacks } from '../github-pr-conflict-resolve';

function createCloudJob(): CloudJob {
  return {
    id: 123,
    type: CloudTaskType.GithubPrConflictResolve,
    payload: {
      repo: 'owner/repo',
      prNumber: 42,
      prTitle: 'Fix conflicts',
      prUrl: 'https://github.com/owner/repo/pull/42',
      headRef: 'feature',
      baseRef: 'main',
    },
    result: null,
  } as unknown as CloudJob;
}

describe('githubPrConflictResolveCallbacks', () => {
  const updateMock = vi.mocked(sdk.cloudJobs.update);

  beforeEach(() => {
    updateMock.mockClear();
  });

  it('persists a parsed completion summary into cloud job result', async () => {
    const cloudJob = createCloudJob();
    const context = {};

    await githubPrConflictResolveCallbacks.onMessage?.(
      cloudJob,
      'task_123',
      {
        type: 'completion',
        text: [
          'Resolved merge conflicts in:',
          '- `apps/api/src/file.ts`',
          '',
          "Decisions I'm not 100% sure:",
          '- Kept the incoming branch validation check.',
        ].join('\n'),
        ts: 1000,
      },
      context,
    );

    expect(updateMock).toHaveBeenCalledWith({
      id: 123,
      result: {
        [CONFLICT_RESOLUTION_SUMMARY_RESULT_KEY]: {
          resolvedFiles: ['apps/api/src/file.ts'],
          controversialDecisions: [
            'Kept the incoming branch validation check.',
          ],
          warnings: [],
        },
      },
    });
  });

  it('ignores unrelated completion text', async () => {
    const cloudJob = createCloudJob();

    await githubPrConflictResolveCallbacks.onMessage?.(
      cloudJob,
      'task_123',
      {
        type: 'completion',
        text: 'Opened draft PR #123.',
        ts: 1000,
      },
      {},
    );

    expect(updateMock).not.toHaveBeenCalled();
  });
});
