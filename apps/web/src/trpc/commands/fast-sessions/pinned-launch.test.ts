const mocks = vi.hoisted(() => ({
  after: vi.fn(),
  launchPinned: vi.fn(),
  refreshTitle: vi.fn(),
  environmentsFindFirst: vi.fn(),
  getRepositories: vi.fn(),
  resolveEnvironmentProvider: vi.fn(),
  resolveSelectedProvider: vi.fn(),
}));

vi.mock('next/server', () => ({ after: mocks.after }));

vi.mock('@roomote/cloud-agents/server', () => ({
  DeploymentReadOnlyError: class DeploymentReadOnlyError extends Error {
    code = 'deployment_read_only';
  },
  launchPinnedFastSessionTask: mocks.launchPinned,
  refreshFastAgentSessionTitle: mocks.refreshTitle,
}));

vi.mock('@roomote/db/server', () => ({
  db: {
    query: { environments: { findFirst: mocks.environmentsFindFirst } },
  },
  environments: { id: 'environments.id' },
  eq: vi.fn(),
}));

vi.mock('@/lib/server', () => ({
  getRepositories: mocks.getRepositories,
}));

vi.mock('@/lib/server/source-control-provider', () => ({
  resolveEnvironmentSourceControlProvider: mocks.resolveEnvironmentProvider,
  resolveSelectedRepositorySourceControlProvider: mocks.resolveSelectedProvider,
}));

import { ALL_REPOSITORIES, TaskPayloadKind } from '@roomote/types';

import type { UserAuthSuccess } from '@/types';
import { startPinnedFastSessionLaunch } from './pinned-launch';

const auth = {
  userId: 'user-1',
  name: 'User One',
  primaryEmail: 'user@example.com',
} as UserAuthSuccess;

const environmentId = '33333333-3333-4333-8333-333333333333';
const launchId = '44444444-4444-4444-8444-444444444444';

describe('startPinnedFastSessionLaunch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.launchPinned.mockResolvedValue({
      sessionId: 'session-1',
      fastConversationId: 'fast-1',
      taskId: 'task-1',
      runId: 7,
    });
    mocks.environmentsFindFirst.mockResolvedValue({ name: 'Backend' });
    mocks.getRepositories.mockResolvedValue([]);
    mocks.resolveEnvironmentProvider.mockResolvedValue('gitlab');
    mocks.resolveSelectedProvider.mockReturnValue(undefined);
    mocks.refreshTitle.mockResolvedValue(null);
    mocks.after.mockImplementation((callback: () => unknown) => {
      void callback();
    });
  });

  it('launches an environment task inside a Session with the request as the prompt', async () => {
    const result = await startPinnedFastSessionLaunch(auth, {
      text: 'Fix the flaky test',
      images: ['data:image/png;base64,AAAA'],
      attachmentTexts: ['stack trace'],
      model: 'openrouter/z-ai/glm-5.2',
      pinnedLaunch: {
        launchId,
        repo: ALL_REPOSITORIES,
        environmentId,
        harness: 'opencode-server',
        computeProvider: 'docker',
      },
    });

    expect(result).toEqual({
      sessionId: 'session-1',
      fastConversationId: 'fast-1',
      taskId: 'task-1',
    });
    expect(mocks.getRepositories).not.toHaveBeenCalled();
    expect(mocks.after).toHaveBeenCalledOnce();
    expect(mocks.refreshTitle).toHaveBeenCalledWith({
      sessionId: 'fast-1',
      userId: 'user-1',
    });
    expect(mocks.launchPinned).toHaveBeenCalledWith({
      userId: 'user-1',
      senderDisplayName: 'User One',
      launchId,
      prompt: 'Fix the flaky test',
      images: ['data:image/png;base64,AAAA'],
      surface: 'web',
      trigger: 'manual',
      kickoffMessage: 'Started a task in Backend.',
      task: {
        type: TaskPayloadKind.StandardTask,
        harness: 'opencode-server',
        computeProvider: 'docker',
        payload: expect.objectContaining({
          repo: ALL_REPOSITORIES,
          environmentId,
          description: expect.stringContaining('Fix the flaky test'),
          images: ['data:image/png;base64,AAAA'],
          blank: false,
          sourceControlProvider: 'gitlab',
          harnessModelOverrides: {
            'opencode-server': 'openrouter/z-ai/glm-5.2',
          },
        }),
      },
    });
    const launchInput = mocks.launchPinned.mock.calls[0]?.[0] as {
      task: { payload: { description: string } };
    };
    expect(launchInput.task.payload.description).toContain('stack trace');
  });

  it('opens a blank workspace for a bare repository launch', async () => {
    mocks.getRepositories.mockResolvedValue([
      { fullName: 'acme/api', sourceControlProvider: 'github' },
      { fullName: 'acme/web', sourceControlProvider: 'github' },
    ]);
    mocks.resolveSelectedProvider.mockReturnValue('github');

    await startPinnedFastSessionLaunch(auth, {
      text: '',
      pinnedLaunch: {
        launchId,
        repo: 'acme/api',
        branch: 'feature/x',
        sha: 'abc1234',
      },
    });

    expect(mocks.resolveSelectedProvider).toHaveBeenCalledWith(
      [{ fullName: 'acme/api', sourceControlProvider: 'github' }],
      ['acme/api'],
    );
    expect(mocks.environmentsFindFirst).not.toHaveBeenCalled();
    expect(mocks.launchPinned).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: '',
        kickoffMessage: 'Opened a workspace in acme/api.',
        task: expect.objectContaining({
          payload: expect.objectContaining({
            repo: 'acme/api',
            branch: 'feature/x',
            sha: 'abc1234',
            blank: true,
            sourceControlProvider: 'github',
          }),
        }),
      }),
    );
    const launchInput = mocks.launchPinned.mock.calls[0]?.[0] as {
      task: { payload: Record<string, unknown> };
    };
    expect(launchInput.task.payload).not.toHaveProperty('description');
    expect(launchInput.task.payload).not.toHaveProperty('environmentId');
  });

  it('surfaces a read-only deployment as its stable error code', async () => {
    const { DeploymentReadOnlyError } =
      await import('@roomote/cloud-agents/server');
    mocks.launchPinned.mockRejectedValue(new DeploymentReadOnlyError());

    await expect(
      startPinnedFastSessionLaunch(auth, {
        text: 'Anything',
        pinnedLaunch: { launchId, repo: ALL_REPOSITORIES, environmentId },
      }),
    ).rejects.toThrow('deployment_read_only');
  });
});
