const { mockCreateRunToken, mockAnswerUserInputRequestMutate } = vi.hoisted(
  () => ({
    mockCreateRunToken: vi.fn(),
    mockAnswerUserInputRequestMutate: vi.fn(),
  }),
);

vi.mock('@roomote/auth', async () => {
  const actual =
    await vi.importActual<typeof import('@roomote/auth')>('@roomote/auth');

  return {
    ...actual,
    createRunToken: mockCreateRunToken,
  };
});

vi.mock('@trpc/client', async () => {
  const actual =
    await vi.importActual<typeof import('@trpc/client')>('@trpc/client');

  return {
    ...actual,
    createTRPCProxyClient: vi.fn(() => ({
      commands: {
        answerUserInputRequest: {
          mutate: mockAnswerUserInputRequestMutate,
        },
      },
    })),
  };
});

import {
  db,
  eq,
  runFactory,
  taskFactory,
  taskRuns,
  tasks,
  userFactory,
} from '@roomote/db/server';
import { RunStatus } from '@roomote/types';

import type { UserAuthSuccess } from '@/types';

import { answerSandboxUserInputRequestCommand } from './index';

function buildMockAuth(
  overrides: Partial<UserAuthSuccess> = {},
): UserAuthSuccess {
  const auth = {
    success: true,
    userType: 'user',
    userId: 'user-answer-request-test',
    isAdmin: false,
    name: 'Test User',
    primaryEmail: 'test@test.com',
    resource: {
      username: 'testuser',
      fullName: 'Test User',
      firstName: 'Test',
      lastName: 'User',
      primaryEmailAddress: { id: '1', emailAddress: 'test@test.com' },
      emailAddresses: [{ id: '1', emailAddress: 'test@test.com' }],
      imageUrl: 'https://example.com/avatar.jpg',
      createdAt: new Date(),
    },
    ...overrides,
  } as UserAuthSuccess;

  return auth as UserAuthSuccess;
}

describe('answerSandboxUserInputRequestCommand', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockResolvedValue(
      new Response('{}', {
        headers: { 'content-type': 'application/json' },
      }),
    );
    mockCreateRunToken.mockResolvedValue('run-token');
    mockAnswerUserInputRequestMutate.mockResolvedValue({ success: true });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('switches the acting user before delivery when the run has no acting user (automation-started)', async () => {
    const user = await userFactory.create({ name: 'DB User' });
    const task = await taskFactory.create({
      initiatorUserId: user.id,
      activityAt: 1,
    });

    // Automation-started runs begin with no acting user.
    const run = await runFactory.create({
      taskId: task.id,
      status: RunStatus.Running,
      sandboxServerUrl: 'http://sandbox.example.test',
      result: {},
    });

    mockAnswerUserInputRequestMutate.mockImplementationOnce(async () => {
      const [updated] = await db
        .select({ activityAt: tasks.activityAt })
        .from(tasks)
        .where(eq(tasks.id, task.id));
      expect(updated?.activityAt).toBeGreaterThan(1);
      return { success: true };
    });

    await answerSandboxUserInputRequestCommand(
      buildMockAuth({
        userId: user.id,
      }),
      {
        taskId: task.id,
        requestId: 'request-1',
        answers: { 'question-1': { answers: ['yes'] } },
      },
    );

    const updatedRun = await db.query.taskRuns.findFirst({
      where: eq(taskRuns.id, run.id),
      columns: { actingUserId: true },
    });

    expect(updatedRun?.actingUserId).toBe(user.id);
    expect(mockAnswerUserInputRequestMutate).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: 'request-1',
        answers: { 'question-1': { answers: ['yes'] } },
      }),
    );
  });

  it('rolls back the acting-user switch when sandbox delivery fails', async () => {
    mockAnswerUserInputRequestMutate.mockRejectedValueOnce(
      new Error('sandbox exploded'),
    );

    const user = await userFactory.create({ name: 'DB User' });
    const task = await taskFactory.create({
      initiatorUserId: user.id,
    });

    const run = await runFactory.create({
      taskId: task.id,
      status: RunStatus.Running,
      sandboxServerUrl: 'http://sandbox.example.test',
      result: {},
    });

    await expect(
      answerSandboxUserInputRequestCommand(
        buildMockAuth({
          userId: user.id,
        }),
        {
          taskId: task.id,
          requestId: 'request-1',
          answers: { 'question-1': { answers: ['yes'] } },
        },
      ),
    ).rejects.toThrow('sandbox exploded');

    const updatedRun = await db.query.taskRuns.findFirst({
      where: eq(taskRuns.id, run.id),
      columns: { actingUserId: true },
    });

    expect(updatedRun?.actingUserId).toBeNull();
  });
});
