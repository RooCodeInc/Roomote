import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockPollGitHubCopilotDeviceAuth,
  mockAutoAddConnectedSubscriptionTaskModels,
} = vi.hoisted(() => ({
  mockPollGitHubCopilotDeviceAuth: vi.fn(),
  mockAutoAddConnectedSubscriptionTaskModels: vi.fn(),
}));

vi.mock('@roomote/db/server', () => ({
  pollGitHubCopilotDeviceAuth: mockPollGitHubCopilotDeviceAuth,
}));

vi.mock('../task-models', () => ({
  autoAddConnectedSubscriptionTaskModels:
    mockAutoAddConnectedSubscriptionTaskModels,
}));

import { pollGitHubCopilotDeviceAuthCommand } from './index';

const adminAuth = { userId: 'user-1', isAdmin: true } as never;

describe('GitHub Copilot subscription commands', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('auto-adds recommended models after a successful connection', async () => {
    mockPollGitHubCopilotDeviceAuth.mockResolvedValue({ status: 'success' });

    await expect(
      pollGitHubCopilotDeviceAuthCommand(adminAuth, {
        deviceCode: 'device-1',
      }),
    ).resolves.toEqual({ status: 'success' });
    expect(mockAutoAddConnectedSubscriptionTaskModels).toHaveBeenCalledWith(
      'github-copilot',
    );
  });

  it('does not change models while authorization is pending', async () => {
    mockPollGitHubCopilotDeviceAuth.mockResolvedValue({ status: 'pending' });

    await pollGitHubCopilotDeviceAuthCommand(adminAuth, {
      deviceCode: 'device-1',
    });

    expect(mockAutoAddConnectedSubscriptionTaskModels).not.toHaveBeenCalled();
  });
});
