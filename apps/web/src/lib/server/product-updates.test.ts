import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockEnv = vi.hoisted(() => ({
  APP_ENV: 'production',
  R_PING_BASE_URL: 'https://ping.example.com/',
}));

vi.mock('./env', () => ({ Env: mockEnv }));

import { subscribeToProductUpdates } from './product-updates';

describe('subscribeToProductUpdates', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    mockEnv.APP_ENV = 'production';
    vi.stubGlobal('fetch', fetchMock);
  });

  it('does not send subscriptions outside production', async () => {
    mockEnv.APP_ENV = 'development';

    await subscribeToProductUpdates('user@example.com', 'setup');

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('posts the account email and source to Ping', async () => {
    fetchMock.mockResolvedValue(new Response());

    await subscribeToProductUpdates('user@example.com', 'setup');

    expect(fetchMock).toHaveBeenCalledWith(
      'https://ping.example.com/v1/emails/subscribe',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ email: 'user@example.com', source: 'setup' }),
      }),
    );
  });

  it('swallows delivery failures', async () => {
    fetchMock.mockRejectedValue(new Error('network unavailable'));

    await expect(
      subscribeToProductUpdates('user@example.com', 'onboarding'),
    ).resolves.toBeUndefined();
  });
});
