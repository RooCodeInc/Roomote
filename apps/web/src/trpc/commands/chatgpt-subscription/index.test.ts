import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockPollChatGptDeviceAuth,
  mockAutoAddConnectedSubscriptionTaskModels,
} = vi.hoisted(() => ({
  mockPollChatGptDeviceAuth: vi.fn(),
  mockAutoAddConnectedSubscriptionTaskModels: vi.fn(),
}));

vi.mock('@roomote/db/server', () => ({
  pollChatGptDeviceAuth: mockPollChatGptDeviceAuth,
}));

vi.mock('../task-models', () => ({
  autoAddConnectedSubscriptionTaskModels:
    mockAutoAddConnectedSubscriptionTaskModels,
}));

import { pollChatGptDeviceAuthCommand } from './index';

const adminAuth = { userId: 'user-1', isAdmin: true } as never;

describe('ChatGPT subscription commands', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('auto-adds recommended models after a successful connection', async () => {
    mockPollChatGptDeviceAuth.mockResolvedValue({ status: 'success' });

    await expect(
      pollChatGptDeviceAuthCommand(adminAuth, {
        deviceAuthId: 'device-1',
        userCode: 'CODE-1',
      }),
    ).resolves.toEqual({ status: 'success' });
    expect(mockAutoAddConnectedSubscriptionTaskModels).toHaveBeenCalledWith(
      'chatgpt',
    );
  });

  it('does not change models while authorization is pending', async () => {
    mockPollChatGptDeviceAuth.mockResolvedValue({ status: 'pending' });

    await pollChatGptDeviceAuthCommand(adminAuth, {
      deviceAuthId: 'device-1',
      userCode: 'CODE-1',
    });

    expect(mockAutoAddConnectedSubscriptionTaskModels).not.toHaveBeenCalled();
  });
});
