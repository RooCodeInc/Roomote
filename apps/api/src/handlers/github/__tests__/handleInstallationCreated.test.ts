const { mockCompletePendingGitHubInstallation, mockSendUserDirectMessage } =
  vi.hoisted(() => ({
    mockCompletePendingGitHubInstallation: vi.fn(),
    mockSendUserDirectMessage: vi.fn(),
  }));

vi.mock('@roomote/github', () => ({
  completePendingGitHubInstallation: mockCompletePendingGitHubInstallation,
}));

vi.mock('@roomote/sdk/server', () => ({
  attemptUserDirectMessage: mockSendUserDirectMessage,
}));

vi.mock('@roomote/env', () => ({
  Env: { R_APP_URL: 'https://roomote.example.com' },
}));

import { handleInstallationCreated } from '../handleInstallationCreated';
import type { WebhookInstallationCreated } from '../types';

const payload = {
  installation: { id: 42 },
} as unknown as WebhookInstallationCreated;

describe('handleInstallationCreated', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSendUserDirectMessage.mockImplementation(async ({ provider }) => ({
      provider,
      status: 'sent',
    }));
  });

  it('notifies the requesting user after completing a pending installation', async () => {
    mockCompletePendingGitHubInstallation.mockResolvedValue({
      success: true,
      githubInstallation: { accountLogin: 'acme-inc' },
      repositories: [],
      requestedByUserId: 'user-1',
    });

    const response = await handleInstallationCreated(payload);

    expect(response).toEqual({ status: 'ok' });
    expect(mockCompletePendingGitHubInstallation).toHaveBeenCalledWith(42);
    expect(mockSendUserDirectMessage).toHaveBeenCalledTimes(4);
    for (const provider of ['slack', 'teams', 'telegram', 'discord']) {
      expect(mockSendUserDirectMessage).toHaveBeenCalledWith({
        provider,
        userId: 'user-1',
        text: 'Your GitHub installation request for acme-inc was approved, and Roomote is now connected. Continue setup here: https://roomote.example.com/setup',
        logContext: 'handleInstallationCreated',
      });
    }
  });

  it('does not notify when completion fails', async () => {
    mockCompletePendingGitHubInstallation.mockResolvedValue({
      success: false,
      error: 'sync failed',
    });

    const response = await handleInstallationCreated(payload);

    expect(response).toEqual({ status: 'ok' });
    expect(mockSendUserDirectMessage).not.toHaveBeenCalled();
  });

  it('still acks the webhook when completion throws', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockCompletePendingGitHubInstallation.mockRejectedValue(
      new Error('Pending GitHub installation not found'),
    );

    const response = await handleInstallationCreated(payload);

    expect(response).toEqual({ status: 'ok' });
    expect(mockSendUserDirectMessage).not.toHaveBeenCalled();

    errorSpy.mockRestore();
  });
});
