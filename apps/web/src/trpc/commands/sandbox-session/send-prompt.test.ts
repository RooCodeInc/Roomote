const {
  mockCreateRunToken,
  mockSendPromptMutate,
  mockClaimOutOfBandContext,
  mockSetLatestUserMessageForReplyQuote,
  mockClearLatestUserMessageForReplyQuoteIfId,
} = vi.hoisted(() => ({
  mockCreateRunToken: vi.fn(),
  mockSendPromptMutate: vi.fn(),
  mockClaimOutOfBandContext: vi.fn(),
  mockSetLatestUserMessageForReplyQuote: vi.fn(),
  mockClearLatestUserMessageForReplyQuoteIfId: vi.fn(),
}));

vi.mock('@roomote/communication/messages', async () => {
  const actual = await vi.importActual<
    typeof import('@roomote/communication/messages')
  >('@roomote/communication/messages');

  return {
    ...actual,
    setLatestUserMessageForReplyQuote: mockSetLatestUserMessageForReplyQuote,
    clearLatestUserMessageForReplyQuoteIfId:
      mockClearLatestUserMessageForReplyQuoteIfId,
  };
});

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

vi.mock('@/lib/server/out-of-band-context', async () => {
  const actual = await vi.importActual<
    typeof import('@/lib/server/out-of-band-context')
  >('@/lib/server/out-of-band-context');

  return {
    ...actual,
    claimOutOfBandContextForPrompt: mockClaimOutOfBandContext,
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
    mockClaimOutOfBandContext.mockResolvedValue(null);
    mockSetLatestUserMessageForReplyQuote.mockResolvedValue({
      id: 'discord-quote-1',
      text: 'keep going',
      userName: 'Test User',
    });
    mockClearLatestUserMessageForReplyQuoteIfId.mockResolvedValue(true);
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
        quoteText: 'keep going',
        source: 'web',
        userName: 'Auth Fallback Name',
      }),
    );
  });

  it('keeps the original user text separate from injected out-of-band context', async () => {
    const user = await userFactory.create({ name: 'DB User' });
    const task = await taskFactory.create({ initiatorUserId: user.id });

    await runFactory.create({
      actingUserId: user.id,
      taskId: task.id,
      status: RunStatus.Running,
      sandboxServerUrl: 'http://sandbox.example.test',
      result: {},
    });
    mockClaimOutOfBandContext.mockResolvedValue({
      contextBlock: '<out_of_band_context>\nnotice\n</out_of_band_context>',
      messageIds: ['out-of-band-message'],
    });

    await sendSandboxPromptCommand(buildMockAuth({ userId: user.id }), {
      taskId: task.id,
      prompt: 'Please fix it.',
      source: 'web',
    });

    expect(mockSendPromptMutate).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt:
          '<out_of_band_context>\nnotice\n</out_of_band_context>\n\nPlease fix it.',
        quoteText: 'Please fix it.',
      }),
    );
  });

  it('stores web follow-ups for the next Discord thread reply quote', async () => {
    const user = await userFactory.create({ name: 'DB User' });
    const task = await taskFactory.create({ initiatorUserId: user.id });

    const run = await runFactory.create({
      actingUserId: user.id,
      taskId: task.id,
      status: RunStatus.Running,
      sandboxServerUrl: 'http://sandbox.example.test',
      payload: {
        communicationProvider: 'discord',
        communicationChannelId: 'channel-1',
        communicationThreadId: 'thread-1',
      },
      result: {},
    });

    await sendSandboxPromptCommand(buildMockAuth({ userId: user.id }), {
      taskId: task.id,
      prompt: 'Please quote this in Discord.',
      source: 'web',
    });

    expect(mockSetLatestUserMessageForReplyQuote).toHaveBeenCalledWith(
      'discord',
      run.id,
      {
        text: 'Please quote this in Discord.',
        userName: 'Test User',
      },
    );
    expect(mockClearLatestUserMessageForReplyQuoteIfId).not.toHaveBeenCalled();
  });

  it('clears the exact Discord quote when sandbox delivery fails', async () => {
    mockSendPromptMutate.mockRejectedValueOnce(new Error('sandbox exploded'));

    const user = await userFactory.create({ name: 'DB User' });
    const task = await taskFactory.create({ initiatorUserId: user.id });

    const run = await runFactory.create({
      actingUserId: user.id,
      taskId: task.id,
      status: RunStatus.Running,
      sandboxServerUrl: 'http://sandbox.example.test',
      payload: {
        communicationProvider: 'discord',
        communicationChannelId: 'channel-1',
      },
      result: {},
    });

    await expect(
      sendSandboxPromptCommand(buildMockAuth({ userId: user.id }), {
        taskId: task.id,
        prompt: 'Do not leave this pending.',
        source: 'web',
      }),
    ).rejects.toThrow('sandbox exploded');

    expect(mockClearLatestUserMessageForReplyQuoteIfId).toHaveBeenCalledWith(
      'discord',
      run.id,
      'discord-quote-1',
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
