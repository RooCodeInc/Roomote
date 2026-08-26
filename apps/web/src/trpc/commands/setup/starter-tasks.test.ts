import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockAssertAdmin,
  mockCompleteSetup,
  mockCreateStandardTaskRun,
  mockCaptureEvent,
  environmentState,
} = vi.hoisted(() => ({
  mockAssertAdmin: vi.fn(),
  mockCompleteSetup: vi.fn(),
  mockCreateStandardTaskRun: vi.fn(),
  mockCaptureEvent: vi.fn(),
  environmentState: { rows: [] as Array<{ id: string }> },
}));

vi.mock('./shared', () => ({
  assertAdmin: (...args: unknown[]) => mockAssertAdmin(...args),
}));

vi.mock('./index', () => ({
  completeSetupCommand: (...args: unknown[]) => mockCompleteSetup(...args),
}));

vi.mock('../task-runs', () => ({
  createStandardTaskRunCommand: (...args: unknown[]) =>
    mockCreateStandardTaskRun(...args),
}));

vi.mock('@roomote/db/server', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({
          orderBy: () => ({
            limit: () => Promise.resolve(environmentState.rows),
          }),
        }),
      }),
    }),
  },
  environments: {
    id: 'environments.id',
    userId: 'environments.userId',
    isEval: 'environments.isEval',
    updatedAt: 'environments.updatedAt',
  },
  and: vi.fn(),
  eq: vi.fn(),
  desc: vi.fn(),
  isNull: vi.fn(),
}));

vi.mock('@roomote/telemetry/server', () => ({
  captureEvent: (...args: unknown[]) => mockCaptureEvent(...args),
}));

import { ALL_REPOSITORIES } from '@roomote/types';

import type { UserAuthSuccess } from '@/types';
import { getSetupStarterTask } from '@/lib/setup-starter-tasks';
import { completeSetupWithStarterTasksCommand } from './starter-tasks';

function buildAuth(overrides: Partial<UserAuthSuccess> = {}): UserAuthSuccess {
  return {
    success: true,
    userType: 'user',
    userId: 'admin-1',
    name: 'Admin',
    primaryEmail: 'admin@example.com',
    isAdmin: true,
    anonymousAnalyticsEnabled: false,
    cloudEnabled: false,
    resource: {
      username: null,
      fullName: null,
      firstName: null,
      lastName: null,
      primaryEmailAddress: null,
      emailAddresses: [],
      imageUrl: '',
      createdAt: null,
    },
    ...overrides,
  } as UserAuthSuccess;
}

describe('completeSetupWithStarterTasksCommand', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    environmentState.rows = [];
    mockCompleteSetup.mockResolvedValue({ success: true });
    mockCreateStandardTaskRun.mockImplementation(
      async (_auth: unknown, input: { payload: { description: string } }) => ({
        success: true,
        id: 1,
        taskId: `task-for:${input.payload.description.slice(0, 20)}`,
      }),
    );
  });

  it('launches each selected starter task with its catalog prompt and completes setup', async () => {
    mockCreateStandardTaskRun
      .mockResolvedValueOnce({ success: true, id: 1, taskId: 'task-ci' })
      .mockResolvedValueOnce({ success: true, id: 2, taskId: 'task-security' });

    const result = await completeSetupWithStarterTasksCommand(buildAuth(), {
      selectedStarterTaskIds: ['speed-up-ci', 'security-scan'],
      anonymousAnalyticsEnabled: true,
      productUpdatesEnabled: false,
    });

    expect(mockAssertAdmin).toHaveBeenCalledOnce();
    expect(mockCreateStandardTaskRun).toHaveBeenCalledTimes(2);
    expect(mockCreateStandardTaskRun).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ userId: 'admin-1' }),
      {
        payload: {
          repo: ALL_REPOSITORIES,
          description: getSetupStarterTask('speed-up-ci').prompt,
        },
      },
    );
    expect(mockCreateStandardTaskRun).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ userId: 'admin-1' }),
      {
        payload: {
          repo: ALL_REPOSITORIES,
          description: getSetupStarterTask('security-scan').prompt,
        },
      },
    );
    expect(mockCompleteSetup).toHaveBeenCalledWith(expect.anything(), {
      anonymousAnalyticsEnabled: true,
      productUpdatesEnabled: false,
    });
    expect(result).toEqual({
      launched: [
        { starterTaskId: 'speed-up-ci', taskId: 'task-ci' },
        { starterTaskId: 'security-scan', taskId: 'task-security' },
      ],
      failed: [],
      setupCompleted: true,
      completionError: null,
    });
    expect(mockCaptureEvent).toHaveBeenCalledWith(
      'setup_starter_tasks_submitted',
      {
        userId: 'admin-1',
        properties: {
          selectedCount: 2,
          launchedCount: 2,
          failedCount: 0,
          starterTaskIds: 'speed-up-ci,security-scan',
        },
      },
    );
  });

  it('deduplicates repeated starter task ids', async () => {
    const result = await completeSetupWithStarterTasksCommand(buildAuth(), {
      selectedStarterTaskIds: ['speed-up-ci', 'speed-up-ci'],
    });

    expect(mockCreateStandardTaskRun).toHaveBeenCalledTimes(1);
    expect(result.launched).toHaveLength(1);
  });

  it('targets the newest deployment environment when one exists', async () => {
    environmentState.rows = [{ id: 'env-newest' }];

    await completeSetupWithStarterTasksCommand(buildAuth(), {
      selectedStarterTaskIds: ['update-dependencies'],
    });

    expect(mockCreateStandardTaskRun).toHaveBeenCalledWith(expect.anything(), {
      payload: {
        repo: ALL_REPOSITORIES,
        environmentId: 'env-newest',
        description: getSetupStarterTask('update-dependencies').prompt,
      },
    });
  });

  it('keeps setup incomplete and reports failures when a launch fails', async () => {
    mockCreateStandardTaskRun
      .mockResolvedValueOnce({ success: true, id: 1, taskId: 'task-ci' })
      .mockResolvedValueOnce({ success: false, error: 'No repositories.' })
      .mockRejectedValueOnce(new Error('enqueue blew up'));

    const result = await completeSetupWithStarterTasksCommand(buildAuth(), {
      selectedStarterTaskIds: [
        'speed-up-ci',
        'security-scan',
        'fix-test-flakes',
      ],
    });

    expect(mockCompleteSetup).not.toHaveBeenCalled();
    expect(result.setupCompleted).toBe(false);
    expect(result.launched).toEqual([
      { starterTaskId: 'speed-up-ci', taskId: 'task-ci' },
    ]);
    expect(result.failed).toEqual([
      { starterTaskId: 'security-scan', error: 'No repositories.' },
      { starterTaskId: 'fix-test-flakes', error: 'enqueue blew up' },
    ]);
    expect(mockCaptureEvent).toHaveBeenCalledWith(
      'setup_starter_tasks_submitted',
      expect.objectContaining({
        properties: expect.objectContaining({
          launchedCount: 1,
          failedCount: 2,
        }),
      }),
    );
  });

  it('completes setup without launching anything for an empty selection', async () => {
    const result = await completeSetupWithStarterTasksCommand(buildAuth(), {
      selectedStarterTaskIds: [],
      productUpdatesEnabled: true,
    });

    expect(mockCreateStandardTaskRun).not.toHaveBeenCalled();
    expect(mockCompleteSetup).toHaveBeenCalledWith(expect.anything(), {
      productUpdatesEnabled: true,
    });
    expect(result).toEqual({
      launched: [],
      failed: [],
      setupCompleted: true,
      completionError: null,
    });
  });

  it('reports a completion error without losing launched tasks', async () => {
    mockCompleteSetup.mockRejectedValueOnce(new Error('settings write failed'));

    const result = await completeSetupWithStarterTasksCommand(buildAuth(), {
      selectedStarterTaskIds: ['fix-test-flakes'],
    });

    expect(result.launched).toHaveLength(1);
    expect(result.failed).toEqual([]);
    expect(result.setupCompleted).toBe(false);
    expect(result.completionError).toBe('settings write failed');
  });
});
