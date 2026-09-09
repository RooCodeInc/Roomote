import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  zadd: vi.fn(),
  zrem: vi.fn(),
  eval: vi.fn(),
}));
vi.mock('@roomote/redis', () => ({ getRedis: () => mocks }));
import {
  claimThreadFooterRefreshTargets,
  scheduleThreadFooterRefresh,
  forgetThreadFooterRefresh,
} from '../thread-footer-refresh';

describe('bounded footer refresh registry', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(Date, 'now').mockReturnValue(1000);
  });
  const target = {
    provider: 'discord' as const,
    channelId: 'C',
    threadId: 'T',
  };
  it('indexes only current destinations, with a 30-second due time', async () => {
    await scheduleThreadFooterRefresh(target);
    expect(mocks.zadd).toHaveBeenCalledWith(
      'thread_footer_refresh:due',
      31_000,
      JSON.stringify(target),
    );
    await forgetThreadFooterRefresh(target);
    expect(mocks.zrem).toHaveBeenCalledWith(
      'thread_footer_refresh:due',
      JSON.stringify(target),
    );
  });
  it('caps claims at 100 and atomically advances claimed targets for retry/fairness', async () => {
    mocks.eval.mockResolvedValue([JSON.stringify(target)]);
    expect(await claimThreadFooterRefreshTargets(1000)).toEqual([target]);
    expect(mocks.eval).toHaveBeenCalledWith(
      expect.stringContaining("'zrangebyscore'"),
      1,
      'thread_footer_refresh:due',
      1000,
      31_000,
      100,
    );
    expect(mocks.eval.mock.calls[0]![0]).toContain("'zadd'");
  });
});
