const { mockCreateRunToken, mockSendPromptMutate } = vi.hoisted(() => ({
  mockCreateRunToken: vi.fn(),
  mockSendPromptMutate: vi.fn(),
}));

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
        sendPrompt: {
          mutate: mockSendPromptMutate,
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
  userFactory,
} from '@roomote/db/server';
import { RunStatus } from '@roomote/types';
import type { FeatureFlag } from '@roomote/feature-flags';

import type { UserAuthSuccess } from '@/types';

import {
  sendSandboxPromptCommand,
  sendSandboxPromptInputSchema,
} from './index';

function buildMockAuth(
  overrides: Partial<UserAuthSuccess> = {},
): UserAuthSuccess {
  const auth = {
    success: true,
    userType: 'user',
    userId: 'user-send-prompt-test',
    isAdmin: false,
    name: 'Test User',
    primaryEmail: 'test@test.com',
    featureFlags: {} as Record<FeatureFlag, boolean>,
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

describe('sendSandboxPromptCommand', () => {
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
    mockSendPromptMutate.mockResolvedValue({ success: true });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('strips browser-supplied userName from the public sendPrompt input', () => {
    expect(
      sendSandboxPromptInputSchema.parse({
        taskId: 'task-send-prompt-test',
        prompt: 'keep going',
        source: 'web',
        userName: 'Spoofed Browser Name',
      }),
    ).toEqual({
      taskId: 'task-send-prompt-test',
      prompt: 'keep going',
      source: 'web',
    });
  });

  it('uses the trimmed authenticated display name instead of trusting the browser payload', async () => {
    const user = await userFactory.create({ name: 'DB User' });
    const task = await taskFactory.create({
      initiatorUserId: user.id,
    });

    await runFactory.create({
      actingUserId: user.id,
      taskId: task.id,
      status: RunStatus.Running,
      sandboxServerUrl: 'http://sandbox.example.test',
      result: {},
    });

    await sendSandboxPromptCommand(
      buildMockAuth({
        userId: user.id,
        name: '  Auth Fallback Name  ',
      }),
      {
        taskId: task.id,
        prompt: 'keep going',
        source: 'web',
      },
    );

    expect(mockSendPromptMutate).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: 'keep going',
        source: 'web',
        userName: 'Auth Fallback Name',
      }),
    );
  });

  it('forwards autoSteerWhenQueued to the sandbox sendPrompt command', async () => {
    const user = await userFactory.create({ name: 'DB User' });
    const task = await taskFactory.create({
      initiatorUserId: user.id,
    });

    await runFactory.create({
      actingUserId: user.id,
      taskId: task.id,
      status: RunStatus.Running,
      sandboxServerUrl: 'http://sandbox.example.test',
      result: {},
    });

    await sendSandboxPromptCommand(
      buildMockAuth({
        userId: user.id,
      }),
      {
        taskId: task.id,
        prompt: 'change direction',
        source: 'web',
        autoSteerWhenQueued: true,
      },
    );

    expect(mockSendPromptMutate).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: 'change direction',
        autoSteerWhenQueued: true,
      }),
    );
  });

  it('falls back to the authenticated email when the user name is blank', async () => {
    const user = await userFactory.create({
      name: 'Casey Example',
      email: 'casey@example.com',
    });
    const task = await taskFactory.create({
      initiatorUserId: user.id,
    });

    await runFactory.create({
      actingUserId: user.id,
      taskId: task.id,
      status: RunStatus.Running,
      sandboxServerUrl: 'http://sandbox.example.test',
      result: {},
    });

    await sendSandboxPromptCommand(
      buildMockAuth({
        userId: user.id,
        name: '   ',
        primaryEmail: 'casey@example.com',
      }),
      {
        taskId: task.id,
        prompt: 'keep going',
        source: 'web',
      },
    );

    expect(mockSendPromptMutate).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: 'keep going',
        source: 'web',
        userName: 'casey',
      }),
    );
  });

  it('returns a conflict before proxying when the sandbox URL is stale or serves HTML', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response('<!DOCTYPE html>', {
        headers: { 'content-type': 'text/html' },
      }),
    );
    const user = await userFactory.create({ name: 'DB User' });
    const task = await taskFactory.create({
      initiatorUserId: user.id,
    });

    await runFactory.create({
      actingUserId: user.id,
      taskId: task.id,
      status: RunStatus.Running,
      sandboxServerUrl: 'http://sandbox.example.test',
      result: {},
    });

    await expect(
      sendSandboxPromptCommand(
        buildMockAuth({
          userId: user.id,
        }),
        {
          taskId: task.id,
          prompt: 'keep going',
          source: 'web',
        },
      ),
    ).rejects.toMatchObject({
      code: 'CONFLICT',
      message:
        'The task is no longer connected to a live sandbox. Refresh the page or start a new task.',
    });

    expect(mockCreateRunToken).not.toHaveBeenCalled();
    expect(mockSendPromptMutate).not.toHaveBeenCalled();
  });

  it('switches the acting user before delivery when the run has no acting user (automation-started)', async () => {
    const user = await userFactory.create({ name: 'DB User' });
    const task = await taskFactory.create({
      initiatorUserId: user.id,
    });

    // Automation-started runs begin with no acting user.
    const run = await runFactory.create({
      taskId: task.id,
      status: RunStatus.Running,
      sandboxServerUrl: 'http://sandbox.example.test',
      result: {},
    });

    await sendSandboxPromptCommand(
      buildMockAuth({
        userId: user.id,
      }),
      {
        taskId: task.id,
        prompt: 'keep going',
        source: 'web',
      },
    );

    const updatedRun = await db.query.taskRuns.findFirst({
      where: eq(taskRuns.id, run.id),
      columns: { actingUserId: true },
    });

    expect(updatedRun?.actingUserId).toBe(user.id);
    expect(mockSendPromptMutate).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: 'keep going',
        // Actor handoffs steer so the previous actor's turn does not keep
        // running after the credential identity changes.
        autoSteerWhenQueued: true,
      }),
    );
  });

  it('does not force steering when the sender is already the acting user', async () => {
    const user = await userFactory.create({ name: 'DB User' });
    const task = await taskFactory.create({
      initiatorUserId: user.id,
    });

    await runFactory.create({
      actingUserId: user.id,
      taskId: task.id,
      status: RunStatus.Running,
      sandboxServerUrl: 'http://sandbox.example.test',
      result: {},
    });

    await sendSandboxPromptCommand(
      buildMockAuth({
        userId: user.id,
      }),
      {
        taskId: task.id,
        prompt: 'keep going',
        source: 'web',
      },
    );

    expect(mockSendPromptMutate).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: 'keep going',
        autoSteerWhenQueued: undefined,
      }),
    );
  });

  it('rolls back the acting-user switch when sandbox delivery fails', async () => {
    mockSendPromptMutate.mockRejectedValueOnce(new Error('sandbox exploded'));

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
      sendSandboxPromptCommand(
        buildMockAuth({
          userId: user.id,
        }),
        {
          taskId: task.id,
          prompt: 'keep going',
          source: 'web',
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
