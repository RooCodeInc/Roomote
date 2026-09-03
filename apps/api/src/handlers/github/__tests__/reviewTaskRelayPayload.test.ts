const mocks = vi.hoisted(() => ({
  getRelayState: vi.fn(),
  getSettings: vi.fn(),
}));

vi.mock('@roomote/cloud-agents/server', () => ({
  getLinkedTaskRelayState: mocks.getRelayState,
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

  it('attaches the PR-origin session when the opening task has a Fast parent', async () => {
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
      fastAgentParent: fastParent,
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
      fastAgentSessionId: fastParent.sessionId,
      fastAgentParent: fastParent,
    });
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
