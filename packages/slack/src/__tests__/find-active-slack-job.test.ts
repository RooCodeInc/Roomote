const { findFirstMock } = vi.hoisted(() => ({
  findFirstMock: vi.fn(),
}));

vi.mock('@roomote/db/server', () => ({
  and: vi.fn((...args: unknown[]) => ({ and: args })),
  cloudJobs: {
    canceledAt: 'canceledAt',
    createdAt: 'createdAt',
    slackThreadTs: 'slackThreadTs',
    status: 'status',
  },
  db: {
    query: {
      cloudJobs: {
        findFirst: findFirstMock,
      },
    },
  },
  desc: vi.fn((value: unknown) => ({ desc: value })),
  eq: vi.fn((left: unknown, right: unknown) => ({ eq: [left, right] })),
  inArray: vi.fn((left: unknown, right: unknown[]) => ({
    inArray: [left, right],
  })),
  isNull: vi.fn((value: unknown) => ({ isNull: value })),
}));

import { activeCloudTaskStatuses } from '@roomote/types';

import { findActiveSlackJob } from '../find-active-slack-job';

describe('findActiveSlackJob', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    findFirstMock.mockResolvedValue(null);
  });

  it('looks up the latest non-canceled job across all active statuses for the thread', async () => {
    await findActiveSlackJob('111.000');

    expect(findFirstMock).toHaveBeenCalledWith({
      where: {
        and: [
          { eq: ['slackThreadTs', '111.000'] },
          { inArray: ['status', [...activeCloudTaskStatuses]] },
          { isNull: 'canceledAt' },
        ],
      },
      orderBy: { desc: 'createdAt' },
    });
  });
});
