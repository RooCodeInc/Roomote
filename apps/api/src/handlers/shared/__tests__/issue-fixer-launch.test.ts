import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockGetSettings, mockRecordOutcome, mockEnqueueTask, mockSelectFrom } =
  vi.hoisted(() => ({
    mockGetSettings: vi.fn(),
    mockRecordOutcome: vi.fn(),
    mockEnqueueTask: vi.fn(),
    mockSelectFrom: vi.fn(),
  }));

vi.mock('@roomote/cloud-agents/server', () => ({
  buildIssueFixerFixPrompt: vi.fn(
    ({ environmentId }: { environmentId: string }) =>
      `prompt-for-${environmentId}`,
  ),
  enqueueTask: mockEnqueueTask,
}));

vi.mock('@roomote/db/server', () => ({
  asc: (value: unknown) => value,
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          orderBy: mockSelectFrom,
        })),
      })),
    })),
  },
  environmentRepositoryMappings: {
    environmentId: 'environmentId',
    repositoryId: 'repositoryId',
  },
  eq: (...args: unknown[]) => args,
  getBackgroundAgentSettingsForDeployment: mockGetSettings,
  recordAutomationRunOutcome: mockRecordOutcome,
}));

vi.mock('@roomote/types', async () => {
  const actual =
    await vi.importActual<typeof import('@roomote/types')>('@roomote/types');
  return {
    ...actual,
    TaskPayloadKind: actual.TaskPayloadKind,
  };
});

import { launchIssueFixerTriage } from '../issue-fixer-launch';

describe('launchIssueFixerTriage', () => {
  beforeEach(() => {
    mockGetSettings.mockReset();
    mockRecordOutcome.mockReset();
    mockEnqueueTask.mockReset();
    mockSelectFrom.mockReset();
    mockGetSettings.mockResolvedValue({ issueFixerFrequency: 'daily' });
    mockRecordOutcome.mockResolvedValue(undefined);
    mockEnqueueTask.mockResolvedValue({ taskId: 'task-1' });
  });

  it('resolves environment by repository id mapping, not full name alone', async () => {
    mockSelectFrom.mockResolvedValue([{ environmentId: 'env-gitlab-only' }]);

    await expect(
      launchIssueFixerTriage({
        sourceControlProvider: 'gitlab',
        repositoryId: 'repo-gitlab-id',
        repositoryFullName: 'acme/backend',
        continueMention: '@roomote',
        issue: {
          number: 3,
          title: 'Broken',
          url: 'https://gitlab.com/acme/backend/-/issues/3',
        },
      }),
    ).resolves.toMatchObject({
      status: 'ok',
      message: expect.stringContaining('Launched Triage Issues'),
    });

    expect(mockEnqueueTask).toHaveBeenCalledWith(
      expect.objectContaining({
        task: expect.objectContaining({
          payload: expect.objectContaining({
            environmentId: 'env-gitlab-only',
            sourceControlProvider: 'gitlab',
            repo: 'acme/backend',
          }),
        }),
      }),
      expect.anything(),
    );
  });

  it('skips launch when the mapped repository has no environment', async () => {
    mockSelectFrom.mockResolvedValue([]);

    await expect(
      launchIssueFixerTriage({
        sourceControlProvider: 'gitea',
        repositoryId: 'repo-gitea-id',
        repositoryFullName: 'acme/backend',
        issue: {
          number: 4,
          title: 'Broken',
          url: 'https://git.example.com/acme/backend/issues/4',
        },
      }),
    ).resolves.toMatchObject({
      status: 'ok',
      message: 'Repository has no configured environment for Triage Issues',
    });

    expect(mockEnqueueTask).not.toHaveBeenCalled();
  });
});
