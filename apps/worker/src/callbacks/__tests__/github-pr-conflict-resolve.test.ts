vi.mock('@roomote/sdk/client', () => ({
  sdk: {
    taskRuns: {
      update: vi.fn().mockResolvedValue(undefined),
    },
  },
}));

import {
  TaskPayloadKind,
  CONFLICT_RESOLUTION_SUMMARY_RESULT_KEY,
} from '@roomote/types';
import { type TaskRun, sdk } from '@roomote/sdk/client';

import { githubPrConflictResolveCallbacks } from '../github-pr-conflict-resolve';

function createTaskRun(): TaskRun {
  return {
    id: 123,
    payloadKind: TaskPayloadKind.GithubPrConflictResolve,
    payload: {
      repo: 'owner/repo',
      prNumber: 42,
      prTitle: 'Fix conflicts',
      prUrl: 'https://github.com/owner/repo/pull/42',
      headRef: 'feature',
      baseRef: 'main',
    },
    result: null,
  } as unknown as TaskRun;
}

describe('githubPrConflictResolveCallbacks', () => {
  const updateMock = vi.mocked(sdk.taskRuns.update);

  beforeEach(() => {
    updateMock.mockClear();
  });

  it('persists a parsed completion summary into task run result', async () => {
    const taskRun = createTaskRun();
    const context = {};

    await githubPrConflictResolveCallbacks.onMessage?.(
      taskRun,
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
    const taskRun = createTaskRun();

    await githubPrConflictResolveCallbacks.onMessage?.(
      taskRun,
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
