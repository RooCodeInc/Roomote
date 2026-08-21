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

  it('keeps the late owner lookup eligible to discover a Fast parent', async () => {
    mocks.getSettings.mockResolvedValue({
      relayReviewResultsToTask: true,
      relayEligibleCreatorIds: ['user-1'],
    });
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
