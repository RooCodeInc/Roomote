// pnpm --filter @roomote/api test src/handlers/slack/__tests__/thread-sync.test.ts

const { mockFindFirstTaskMessage } = vi.hoisted(() => ({
  mockFindFirstTaskMessage: vi.fn(),
}));

vi.mock('@roomote/db/server', () => ({
  db: {
    query: {
      taskMessages: {
        findFirst: (...args: unknown[]) => mockFindFirstTaskMessage(...args),
      },
    },
  },
}));

import { getIsSlackDiverged } from '../helpers/thread-sync';

describe('getIsSlackDiverged', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns true when there is no tracked bot reply', async () => {
    await expect(
      getIsSlackDiverged({ runId: 1, trackedBotReply: null }),
    ).resolves.toBe(true);
    expect(mockFindFirstTaskMessage).not.toHaveBeenCalled();
  });

  it('returns true for out-of-band bot replies without consulting the transcript', async () => {
    await expect(
      getIsSlackDiverged({
        runId: 1,
        trackedBotReply: {
          ts: '2000.000',
          text: 'background notification',
          outOfBand: true,
        },
      }),
    ).resolves.toBe(true);
    expect(mockFindFirstTaskMessage).not.toHaveBeenCalled();
  });

  it('returns false when the tracked session reply is newer than the transcript', async () => {
    mockFindFirstTaskMessage.mockResolvedValue({
      ts: 1_000_000,
    });

    await expect(
      getIsSlackDiverged({
        runId: 1,
        trackedBotReply: { ts: '2000.000', text: 'closeout reply' },
      }),
    ).resolves.toBe(false);
  });

  it('returns true when the transcript moved past the tracked reply', async () => {
    mockFindFirstTaskMessage.mockResolvedValue({
      ts: 3_000_000,
    });

    await expect(
      getIsSlackDiverged({
        runId: 1,
        trackedBotReply: { ts: '2000.000', text: 'older reply' },
      }),
    ).resolves.toBe(true);
  });
});
