import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('@roomote/env', () => ({
  Env: { R_APP_URL: 'https://app.example.com' },
}));
const mocks = vi.hoisted(() => ({
  zadd: vi.fn(),
  zrem: vi.fn(),
  eval: vi.fn(),
}));
vi.mock('@roomote/redis', () => ({ getRedis: () => mocks }));
import {
  claimThreadFooterRefreshTargets,
  classifyThreadFooterActivity,
  scheduleThreadFooterRefresh,
  forgetThreadFooterRefresh,
  getThreadFooterNavigationUrl,
  getThreadFooterPullRequestLinks,
  rescheduleThreadFooterRefresh,
  THREAD_FOOTER_SETTLED_AFTER_MS,
} from '../thread-footer-refresh';

describe('bounded footer refresh registry', () => {
  it('parses supported navigation links without consuming nested open parentheses', () => {
    const url = 'https://app.example.com/sessions/session';
    expect(
      getThreadFooterNavigationUrl(`_[Open in Roomote](${url})_`)?.href,
    ).toBe(url);
    expect(
      getThreadFooterNavigationUrl(`_<${url}|Open in Roomote>_`)?.href,
    ).toBe(url);
    expect(
      getThreadFooterNavigationUrl('[Open in Roomote](('.repeat(20_000)),
    ).toBeNull();
    expect(
      getThreadFooterNavigationUrl(
        '_[Open in Roomote](https://other.example/sessions/session)_',
      ),
    ).toBeNull();
  });
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
  it('caps claims at 100 and leases claimed targets past the scheduler cadence', async () => {
    mocks.eval.mockResolvedValue([JSON.stringify(target)]);
    expect(await claimThreadFooterRefreshTargets(1000)).toEqual([target]);
    expect(mocks.eval).toHaveBeenCalledWith(
      expect.stringContaining("'zrangebyscore'"),
      1,
      'thread_footer_refresh:due',
      1000,
      301_000,
      100,
    );
    expect(mocks.eval.mock.calls[0]![0]).toContain("'zadd'");
  });
  it('checks active destinations every 30 seconds and idle ones every 5 minutes', async () => {
    await rescheduleThreadFooterRefresh(target, 'active');
    expect(mocks.zadd).toHaveBeenLastCalledWith(
      'thread_footer_refresh:due',
      31_000,
      JSON.stringify(target),
    );
    await rescheduleThreadFooterRefresh(target, 'idle');
    expect(mocks.zadd).toHaveBeenLastCalledWith(
      'thread_footer_refresh:due',
      301_000,
      JSON.stringify(target),
    );
  });
  it('settles only quiet Sessions with nothing running or previewing', () => {
    const now = THREAD_FOOTER_SETTLED_AFTER_MS * 2;
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const recent = { sessionActivityAt: now - 60_000 };
    const quiet = {
      sessionActivityAt: now - THREAD_FOOTER_SETTLED_AFTER_MS - 1,
    };
    expect(
      classifyThreadFooterActivity({
        ...quiet,
        runningTasks: { count: 1, url: 'u' },
      }),
    ).toEqual({ active: true, settled: false });
    expect(
      classifyThreadFooterActivity({ ...quiet, livePreviewUrl: 'https://p' }),
    ).toEqual({ active: true, settled: false });
    expect(
      classifyThreadFooterActivity({
        ...recent,
        runningTasks: { count: 0, url: 'u' },
      }),
    ).toEqual({ active: false, settled: false });
    expect(
      classifyThreadFooterActivity({
        ...quiet,
        runningTasks: { count: 0, url: 'u' },
      }),
    ).toEqual({ active: false, settled: true });
    // No Session at all: nothing can start, so an idle footer settles at once.
    expect(classifyThreadFooterActivity({})).toEqual({
      active: false,
      settled: true,
    });
  });
  it('reads the pull request links a footer already shows, in order', () => {
    expect(
      getThreadFooterPullRequestLinks(
        '_<https://app/tasks|No running tasks> · <https://github.com/o/r/pull/7?a=1&amp;b=2|PR #7> · <https://github.com/o/r/pull/9|PR #9> · <https://app/sessions/s|Open in Roomote>_',
      ),
    ).toEqual([
      { prNumber: 7, prUrl: 'https://github.com/o/r/pull/7?a=1&b=2' },
      { prNumber: 9, prUrl: 'https://github.com/o/r/pull/9' },
    ]);
    expect(
      getThreadFooterPullRequestLinks(
        '-# _[PR #12](https://github.com/o/r/pull/12) · [Open in Roomote](https://app/sessions/s)_',
      ),
    ).toEqual([{ prNumber: 12, prUrl: 'https://github.com/o/r/pull/12' }]);
    expect(
      getThreadFooterPullRequestLinks('_[Open in Roomote](https://app)_'),
    ).toEqual([]);
  });
});
