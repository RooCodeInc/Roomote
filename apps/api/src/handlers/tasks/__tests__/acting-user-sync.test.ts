const { mockDbUpdate, mockDbSet, mockDbWhere, mockLogHandlerError } =
  vi.hoisted(() => {
    const mockDbWhere = vi.fn();
    const mockDbSet = vi.fn(() => ({ where: mockDbWhere }));
    const mockDbUpdate = vi.fn(() => ({ set: mockDbSet }));

    return {
      mockDbUpdate,
      mockDbSet,
      mockDbWhere,
      mockLogHandlerError: vi.fn(),
    };
  });

vi.mock('@roomote/db/server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@roomote/db/server')>();

  return {
    ...actual,
    db: {
      update: mockDbUpdate,
    },
  };
});

vi.mock('../../utils', () => ({
  logHandlerError: mockLogHandlerError,
}));

import {
  syncActingUserForInboundMessage,
  updateActingUserIdIfNeeded,
} from '../acting-user-sync';

describe('updateActingUserIdIfNeeded', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDbWhere.mockResolvedValue(undefined);
  });

  it('writes the next acting user when it differs', async () => {
    await updateActingUserIdIfNeeded({
      jobId: 42,
      currentActingUserId: 'user-1',
      nextActingUserId: 'user-2',
      preserveActor: false,
    });

    expect(mockDbSet).toHaveBeenCalledWith({ actingUserId: 'user-2' });
  });

  it('is idempotent: skips the write when the actor already matches', async () => {
    await updateActingUserIdIfNeeded({
      jobId: 42,
      currentActingUserId: 'user-2',
      nextActingUserId: 'user-2',
      preserveActor: false,
    });

    expect(mockDbUpdate).not.toHaveBeenCalled();
  });

  it('never overwrites the actor for actor-preserving sender modes', async () => {
    await updateActingUserIdIfNeeded({
      jobId: 42,
      currentActingUserId: 'user-1',
      nextActingUserId: 'user-2',
      preserveActor: true,
    });

    expect(mockDbUpdate).not.toHaveBeenCalled();
  });

  it('propagates write failures so callers can abort delivery', async () => {
    mockDbWhere.mockRejectedValueOnce(new Error('db unavailable'));

    await expect(
      updateActingUserIdIfNeeded({
        jobId: 42,
        currentActingUserId: 'user-1',
        nextActingUserId: 'user-2',
        preserveActor: false,
      }),
    ).rejects.toThrow('db unavailable');
  });
});

describe('syncActingUserForInboundMessage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDbWhere.mockResolvedValue(undefined);
  });

  it('writes the mapped sender as the acting user before the message is queued', async () => {
    await syncActingUserForInboundMessage({
      logContext: 'test.queue',
      jobId: 42,
      senderUserId: 'user-2',
    });

    expect(mockDbSet).toHaveBeenCalledWith({ actingUserId: 'user-2' });
  });

  it('skips unmapped senders so the run keeps its current actor', async () => {
    await syncActingUserForInboundMessage({
      logContext: 'test.queue',
      jobId: 42,
      senderUserId: undefined,
    });
    await syncActingUserForInboundMessage({
      logContext: 'test.queue',
      jobId: 42,
      senderUserId: null,
    });

    expect(mockDbUpdate).not.toHaveBeenCalled();
  });

  it('is non-fatal: logs write failures instead of throwing', async () => {
    // If this write fails the worker detects the mismatch at delivery time
    // and runs the turn under the server actor — queueing must not break.
    mockDbWhere.mockRejectedValueOnce(new Error('db unavailable'));

    await expect(
      syncActingUserForInboundMessage({
        logContext: 'test.queue',
        jobId: 42,
        senderUserId: 'user-2',
      }),
    ).resolves.toBeUndefined();

    expect(mockLogHandlerError).toHaveBeenCalledWith(
      'test.queue',
      expect.stringContaining('db unavailable'),
    );
  });
});
