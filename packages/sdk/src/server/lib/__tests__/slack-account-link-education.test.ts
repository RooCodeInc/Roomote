const mockRedisSet = vi.fn();
const mockRedisDel = vi.fn();
const mockQueueGetJob = vi.fn();
const mockQueueAdd = vi.fn();

vi.mock('@roomote/redis', () => ({
  getRedis: () => ({
    set: (...args: unknown[]) => mockRedisSet(...args),
    del: (...args: unknown[]) => mockRedisDel(...args),
  }),
}));

vi.mock('bullmq', () => ({
  Queue: class MockQueue {
    getJob = (...args: unknown[]) => mockQueueGetJob(...args);
    add = (...args: unknown[]) => mockQueueAdd(...args);
  },
}));

import {
  enqueueSlackAccountLinkEducation,
  SLACK_ACCOUNT_LINK_EDUCATION_DELAY_MS,
} from '../slack-account-link-education';

const input = {
  slackTeamId: 'T123',
  slackUserId: 'U456',
  userId: 'user-1',
  mappingLinkedAt: new Date('2026-04-08T09:00:00.000Z'),
};

describe('enqueueSlackAccountLinkEducation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRedisSet.mockResolvedValue('OK');
    mockRedisDel.mockResolvedValue(1);
    mockQueueGetJob.mockResolvedValue(null);
    mockQueueAdd.mockResolvedValue(undefined);
  });

  it('enqueues the delayed education DM with a deterministic job id', async () => {
    const result = await enqueueSlackAccountLinkEducation(input);

    expect(result).toEqual({
      enqueued: true,
      jobId: `slack-account-link-education-T123-U456-user-1-${input.mappingLinkedAt.getTime()}`,
    });
    expect(mockQueueAdd).toHaveBeenCalledWith(
      'send-account-link-education',
      {
        slackTeamId: 'T123',
        slackUserId: 'U456',
        userId: 'user-1',
        mappingLinkedAt: input.mappingLinkedAt,
      },
      expect.objectContaining({
        jobId: `slack-account-link-education-T123-U456-user-1-${input.mappingLinkedAt.getTime()}`,
        delay: SLACK_ACCOUNT_LINK_EDUCATION_DELAY_MS,
      }),
    );
  });

  it('suppresses duplicate scheduling when another enqueue already claimed the job', async () => {
    mockRedisSet.mockResolvedValue(null);

    const result = await enqueueSlackAccountLinkEducation(input);

    expect(result).toEqual({
      enqueued: false,
      reason: 'already_scheduled',
      jobId: `slack-account-link-education-T123-U456-user-1-${input.mappingLinkedAt.getTime()}`,
    });
    expect(mockQueueGetJob).not.toHaveBeenCalled();
    expect(mockQueueAdd).not.toHaveBeenCalled();
  });

  it('suppresses duplicate scheduling when the delayed job already exists', async () => {
    mockQueueGetJob.mockResolvedValue({ id: 'existing-job' });

    const result = await enqueueSlackAccountLinkEducation(input);

    expect(result).toEqual({
      enqueued: false,
      reason: 'already_scheduled',
      jobId: `slack-account-link-education-T123-U456-user-1-${input.mappingLinkedAt.getTime()}`,
    });
    expect(mockQueueAdd).not.toHaveBeenCalled();
  });

  it('enqueues a fresh delayed job for a real relink of the same tuple', async () => {
    const firstLink = {
      ...input,
      mappingLinkedAt: new Date('2026-04-08T09:00:00.000Z'),
    };
    const relink = {
      ...input,
      mappingLinkedAt: new Date('2026-04-08T09:25:00.000Z'),
    };

    const firstResult = await enqueueSlackAccountLinkEducation(firstLink);
    const secondResult = await enqueueSlackAccountLinkEducation(relink);

    expect(firstResult).toEqual({
      enqueued: true,
      jobId: `slack-account-link-education-T123-U456-user-1-${firstLink.mappingLinkedAt.getTime()}`,
    });
    expect(secondResult).toEqual({
      enqueued: true,
      jobId: `slack-account-link-education-T123-U456-user-1-${relink.mappingLinkedAt.getTime()}`,
    });
    expect(mockQueueAdd).toHaveBeenCalledTimes(2);
    expect(firstResult.jobId).not.toBe(secondResult.jobId);
  });

  it('cleans up the Redis claim if queue insertion fails', async () => {
    mockQueueAdd.mockRejectedValue(new Error('Redis down'));

    await expect(enqueueSlackAccountLinkEducation(input)).rejects.toThrow(
      'Redis down',
    );

    expect(mockRedisDel).toHaveBeenCalledWith(
      `slack-account-link-education:scheduled:slack-account-link-education-T123-U456-user-1-${input.mappingLinkedAt.getTime()}`,
    );
  });
});
