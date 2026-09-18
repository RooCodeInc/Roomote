const mocks = vi.hoisted(() => ({
  getRelayState: vi.fn(),
  getSettings: vi.fn(),
  getPrOriginFastAgentParent: vi.fn(async (): Promise<unknown> => null),
}));

vi.mock('@roomote/cloud-agents/server', () => ({
  getLinkedTaskRelayState: mocks.getRelayState,
  getPrOriginFastAgentParent: mocks.getPrOriginFastAgentParent,
}));

vi.mock('@roomote/db/server', () => ({
  getReviewCodeAutomationSettings: mocks.getSettings,
}));

import { getReviewTaskRelayPayload } from '../reviewTaskRelayPayload';

describe('getReviewTaskRelayPayload', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSettings.mockResolvedValue({
      relayReviewResultsToTask: false,
      relayEligibleCreatorIds: [],
    });
  });

  it('enables a Fast-parent handoff even when ordinary task relay is disabled', async () => {
    mocks.getRelayState.mockResolvedValue({
      linkedTaskId: 'implementation-task',
      relayEnabled: true,
      handoffTarget: 'fast_parent',
    });

    await expect(
      getReviewTaskRelayPayload({
        repository: 'acme/app',
        prNumber: 42,
        branchName: 'feature/test',
      }),
    ).resolves.toEqual({
      relayReviewResultsToTask: true,
      linkedTaskId: 'implementation-task',
      linkedReviewHandoffTarget: 'fast_parent',
    });
  });

  it('attaches the PR-origin session pinned to the reviewing repository row', async () => {
    const fastParent = {
      sessionId: 'a3a5e5f5-9c9e-4a37-9a06-000000000001',
      conversation: {
        surface: 'slack',
        workspaceId: 'T123',
        conversationId: '100.001',
        replyTarget: { channelId: 'C123', threadId: '100.001' },
      },
    };
    mocks.getRelayState.mockResolvedValue({
      linkedTaskId: 'implementation-task',
      relayEnabled: true,
      handoffTarget: 'fast_parent',
    });
    mocks.getPrOriginFastAgentParent.mockResolvedValueOnce(fastParent);

    await expect(
      getReviewTaskRelayPayload({
        repository: 'acme/app',
        prNumber: 42,
        branchName: 'feature/test',
        repositoryId: 'repo-1',
        host: 'github.com',
      }),
    ).resolves.toEqual({
      relayReviewResultsToTask: true,
      linkedTaskId: 'implementation-task',
      linkedReviewHandoffTarget: 'fast_parent',
      fastAgentSessionId: fastParent.sessionId,
      fastAgentParent: fastParent,
    });
    expect(mocks.getPrOriginFastAgentParent).toHaveBeenCalledWith({
      repository: 'acme/app',
      prNumber: 42,
      branchName: 'feature/test',
      repositoryId: 'repo-1',
      host: 'github.com',
    });
  });

  it('skips the session attachment when no repository row id is supplied', async () => {
    mocks.getRelayState.mockResolvedValue({
      linkedTaskId: null,
      relayEnabled: false,
    });

    await expect(
      getReviewTaskRelayPayload({
        repository: 'acme/app',
        prNumber: 42,
        branchName: 'feature/test',
      }),
    ).resolves.toEqual({ relayReviewResultsToTask: false });
    expect(mocks.getPrOriginFastAgentParent).not.toHaveBeenCalled();
  });

  it('keeps the late owner lookup eligible when ordinary relay is disabled', async () => {
    mocks.getRelayState.mockResolvedValue({
      linkedTaskId: null,
      relayEnabled: false,
      ownerLookupPending: true,
    });

    await expect(
      getReviewTaskRelayPayload({
        repository: 'acme/app',
        prNumber: 42,
        branchName: 'feature/test',
        prBody:
          'Opened on behalf of someone. [Task](https://roomote.dev/task/task-1)',
      }),
    ).resolves.toEqual({
      relayReviewResultsToTask: true,
      linkedTaskRelayLookupPending: true,
    });
  });
});
