const {
  mockCompareAndSetTrustedRunActingUser,
  mockSetTrustedRunActingUser,
  mockLogHandlerError,
} = vi.hoisted(() => ({
  mockCompareAndSetTrustedRunActingUser: vi.fn(),
  mockSetTrustedRunActingUser: vi.fn(),
  mockLogHandlerError: vi.fn(),
}));

vi.mock('@roomote/db/server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@roomote/db/server')>();

  return {
    ...actual,
    compareAndSetTrustedRunActingUser: mockCompareAndSetTrustedRunActingUser,
    setTrustedRunActingUser: mockSetTrustedRunActingUser,
  };
});

vi.mock('../../utils', () => ({
  logHandlerError: mockLogHandlerError,
}));

import {
  restoreActingUserIdAfterFailedDelivery,
  syncActingUserForInboundMessage,
  updateActingUserIdIfNeeded,
} from '../acting-user-sync';

describe('updateActingUserIdIfNeeded', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCompareAndSetTrustedRunActingUser.mockResolvedValue(true);
  });

  it('writes the next acting user when it differs', async () => {
    await updateActingUserIdIfNeeded({
      runId: 42,
      currentActingUserId: 'user-1',
      nextActingUserId: 'user-2',
      preserveActor: false,
    });

    expect(mockCompareAndSetTrustedRunActingUser).toHaveBeenCalledWith({
      runId: 42,
      expectedUserId: 'user-1',
      nextUserId: 'user-2',
    });
  });

  it('is idempotent: skips the write when the actor already matches', async () => {
    await updateActingUserIdIfNeeded({
      runId: 42,
      currentActingUserId: 'user-2',
      nextActingUserId: 'user-2',
      preserveActor: false,
    });

    expect(mockCompareAndSetTrustedRunActingUser).not.toHaveBeenCalled();
  });

  it('never overwrites the actor for actor-preserving sender modes', async () => {
    await updateActingUserIdIfNeeded({
      runId: 42,
      currentActingUserId: 'user-1',
      nextActingUserId: 'user-2',
      preserveActor: true,
    });

    expect(mockCompareAndSetTrustedRunActingUser).not.toHaveBeenCalled();
  });

  it('propagates write failures so callers can abort delivery', async () => {
    mockCompareAndSetTrustedRunActingUser.mockRejectedValueOnce(
      new Error('db unavailable'),
    );

    await expect(
      updateActingUserIdIfNeeded({
        runId: 42,
        currentActingUserId: 'user-1',
        nextActingUserId: 'user-2',
        preserveActor: false,
      }),
    ).rejects.toThrow('db unavailable');
  });
});

describe('restoreActingUserIdAfterFailedDelivery', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCompareAndSetTrustedRunActingUser.mockResolvedValue(true);
  });

  it('rolls back only while the attempted actor still owns the run', async () => {
    await restoreActingUserIdAfterFailedDelivery({
      handlerName: 'sendMessageToTask',
      runId: 42,
      previousActingUserId: 'user-1',
      attemptedActingUserId: 'user-2',
    });

    expect(mockCompareAndSetTrustedRunActingUser).toHaveBeenCalledWith({
      runId: 42,
      expectedUserId: 'user-2',
      nextUserId: 'user-1',
    });
  });

  it('keeps the delivery error primary when rollback fails', async () => {
    mockCompareAndSetTrustedRunActingUser.mockRejectedValueOnce(
      new Error('rollback unavailable'),
    );

    await expect(
      restoreActingUserIdAfterFailedDelivery({
        handlerName: 'sendMessageToTask',
        runId: 42,
        previousActingUserId: 'user-1',
        attemptedActingUserId: 'user-2',
      }),
    ).resolves.toBeUndefined();

    expect(mockLogHandlerError).toHaveBeenCalledWith(
      'sendMessageToTask',
      expect.stringContaining('rollback unavailable'),
    );
  });
});

describe('syncActingUserForInboundMessage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSetTrustedRunActingUser.mockResolvedValue(undefined);
  });

  it('writes the mapped sender as the acting user before the message is queued', async () => {
    await syncActingUserForInboundMessage({
      logContext: 'test.queue',
      runId: 42,
      senderUserId: 'user-2',
    });

    expect(mockSetTrustedRunActingUser).toHaveBeenCalledWith({
      runId: 42,
      userId: 'user-2',
    });
  });

  it('skips unmapped senders so the run keeps its current actor', async () => {
    await syncActingUserForInboundMessage({
      logContext: 'test.queue',
      runId: 42,
      senderUserId: undefined,
    });
    await syncActingUserForInboundMessage({
      logContext: 'test.queue',
      runId: 42,
      senderUserId: null,
    });

    expect(mockSetTrustedRunActingUser).not.toHaveBeenCalled();
  });

  it('is non-fatal: logs write failures instead of throwing', async () => {
    // If this write fails the worker detects the mismatch at delivery time
    // and skips the message — queueing the webhook itself must not break.
    mockSetTrustedRunActingUser.mockRejectedValueOnce(
      new Error('db unavailable'),
    );

    await expect(
      syncActingUserForInboundMessage({
        logContext: 'test.queue',
        runId: 42,
        senderUserId: 'user-2',
      }),
    ).resolves.toBeUndefined();

    expect(mockLogHandlerError).toHaveBeenCalledWith(
      'test.queue',
      expect.stringContaining('db unavailable'),
    );
  });
});
