const { mockCreateJobToken, mockSendPromptMutate } = vi.hoisted(() => ({
  mockCreateJobToken: vi.fn(),
  mockSendPromptMutate: vi.fn(),
}));

vi.mock('@roomote/auth', async () => {
  const actual =
    await vi.importActual<typeof import('@roomote/auth')>('@roomote/auth');

  return {
    ...actual,
    createJobToken: mockCreateJobToken,
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

import { cloudJobFactory, taskFactory, userFactory } from '@roomote/db/server';
import { CloudTaskStatus } from '@roomote/types';
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
    mockCreateJobToken.mockResolvedValue('job-token');
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
      userId: user.id,
    });

    await cloudJobFactory.create({
      userId: user.id,
      taskId: task.id,
      status: CloudTaskStatus.Running,
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

  it('falls back to the authenticated email when the user name is blank', async () => {
    const user = await userFactory.create({
      name: 'Casey Example',
      email: 'casey@example.com',
    });
    const task = await taskFactory.create({
      userId: user.id,
    });

    await cloudJobFactory.create({
      userId: user.id,
      taskId: task.id,
      status: CloudTaskStatus.Running,
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
      userId: user.id,
    });

    await cloudJobFactory.create({
      userId: user.id,
      taskId: task.id,
      status: CloudTaskStatus.Running,
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

    expect(mockCreateJobToken).not.toHaveBeenCalled();
    expect(mockSendPromptMutate).not.toHaveBeenCalled();
  });
});
