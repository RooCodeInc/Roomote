const mocks = vi.hoisted(() => ({
  findTaskRun: vi.fn(),
  findInstallation: vi.fn(),
  getSlackLiveTaskStreamData: vi.fn(),
}));

vi.mock('@roomote/db/server', () => ({
  and: vi.fn((...args: unknown[]) => ({ and: args })),
  eq: vi.fn((column: unknown, value: unknown) => ({ eq: [column, value] })),
  slackInstallations: { isActive: 'isActive', teamId: 'teamId' },
  taskRuns: { id: 'id' },
  db: {
    query: {
      taskRuns: { findFirst: mocks.findTaskRun },
      slackInstallations: { findFirst: mocks.findInstallation },
    },
  },
}));

vi.mock('@roomote/slack', () => ({
  buildSlackLiveTaskTitle: (title: string) => title,
  getSlackLiveTaskStreamData: mocks.getSlackLiveTaskStreamData,
}));

import { getSlackLiveTaskStreamDataForRun } from '../slack-live-task-stream';

const cardData = {
  teamId: 'T123',
  channel: 'C123',
  messageTs: 'card-ts',
  taskId: 'task-1',
  taskUpdateId: 'roomote-task-task-1',
  threadTs: '100.001',
  title: 'Add a regression test',
};

describe('getSlackLiveTaskStreamDataForRun', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findTaskRun.mockResolvedValue({
      taskId: 'task-1',
      task: { title: 'Generated title' },
    });
    mocks.getSlackLiveTaskStreamData.mockResolvedValue(cardData);
    mocks.findInstallation.mockResolvedValue({ botAccessToken: 'xoxb-123' });
  });

  it("resolves the bot token from the card's own team only", async () => {
    await expect(getSlackLiveTaskStreamDataForRun(42)).resolves.toEqual({
      ...cardData,
      title: 'Generated title',
      botAccessToken: 'xoxb-123',
    });

    expect(mocks.findInstallation).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          and: [{ eq: ['isActive', true] }, { eq: ['teamId', 'T123'] }],
        },
      }),
    );
  });

  it('returns nothing when the owning workspace has no active installation', async () => {
    mocks.findInstallation.mockResolvedValue(undefined);

    await expect(getSlackLiveTaskStreamDataForRun(42)).resolves.toBeNull();
  });

  it('returns nothing for runs without a card', async () => {
    mocks.getSlackLiveTaskStreamData.mockResolvedValue(null);

    await expect(getSlackLiveTaskStreamDataForRun(42)).resolves.toBeNull();
    expect(mocks.findInstallation).not.toHaveBeenCalled();
  });
});
