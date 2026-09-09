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
  scheduleThreadFooterRefresh,
  forgetThreadFooterRefresh,
  getThreadFooterNavigationUrl,
} from '../thread-footer-refresh';

describe('bounded footer refresh registry', () => {
  it('parses supported navigation links without consuming nested open parentheses', () => {
    const url = 'https://app.example.com/sessions/session';
    expect(getThreadFooterNavigationUrl(`_[Web app](${url})_`)?.href).toBe(url);
    expect(getThreadFooterNavigationUrl(`_<${url}|Web app>_`)?.href).toBe(url);
    expect(
      getThreadFooterNavigationUrl('[Web app](('.repeat(20_000)),
    ).toBeNull();
    expect(
      getThreadFooterNavigationUrl(
        '_[Web app](https://other.example/sessions/session)_',
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
