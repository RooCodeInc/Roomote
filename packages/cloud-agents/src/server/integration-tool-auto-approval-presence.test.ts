import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  isPresent: vi.fn(async () => true),
}));

vi.mock('@roomote/redis', () => ({
  isSessionUserPresent: mocks.isPresent,
}));

import { isSessionUserPresent } from '@roomote/redis';
import {
  isAutoApprovalChatSurface,
  isAutoApprovalRequesterPresent,
} from './integration-tool-auto-approval-presence';

const requester = {
  sessionId: 'session-1',
  userId: 'owner-1',
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
  mocks.isPresent.mockResolvedValue(true);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('isAutoApprovalChatSurface', () => {
  it.each(['slack', 'discord', 'teams', 'telegram'])(
    'classifies %s as present without a browser lease',
    (surface) => {
      expect(isAutoApprovalChatSurface(surface)).toBe(true);
    },
  );

  it.each(['web', 'agentmail', 'automation', 'github', null, undefined])(
    'does not classify %s as a chat surface',
    (surface) => {
      expect(isAutoApprovalChatSurface(surface)).toBe(false);
    },
  );
});

describe('isAutoApprovalRequesterPresent', () => {
  it('uses browser presence for web sessions and preserves an absent result', async () => {
    mocks.isPresent.mockResolvedValueOnce(false);

    await expect(
      isAutoApprovalRequesterPresent({ ...requester, surface: 'web' }),
    ).resolves.toBe(false);
    expect(isSessionUserPresent).toHaveBeenCalledWith(requester);
  });

  it.each(['slack', 'discord', 'teams', 'telegram'])(
    'treats %s requesters as present without a Redis lookup',
    async (surface) => {
      mocks.isPresent.mockResolvedValue(false);

      await expect(
        isAutoApprovalRequesterPresent({ ...requester, surface }),
      ).resolves.toBe(true);
      expect(isSessionUserPresent).not.toHaveBeenCalled();
    },
  );

  it('fails open when the browser-presence lookup rejects', async () => {
    mocks.isPresent.mockRejectedValueOnce(new Error('redis unavailable'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await expect(
      isAutoApprovalRequesterPresent({ ...requester, surface: 'web' }),
    ).resolves.toBe(true);
    expect(warn).toHaveBeenCalledOnce();
  });

  it('fails open when the browser-presence lookup exceeds two seconds', async () => {
    vi.useFakeTimers();
    mocks.isPresent.mockReturnValueOnce(new Promise<boolean>(() => undefined));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const presence = isAutoApprovalRequesterPresent({
      ...requester,
      surface: 'web',
    });
    await vi.advanceTimersByTimeAsync(2_000);

    await expect(presence).resolves.toBe(true);
    expect(warn).toHaveBeenCalledOnce();
  });
});
