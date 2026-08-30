const mocks = vi.hoisted(() => ({
  claim: vi.fn(),
  complete: vi.fn(),
  dispatch: vi.fn(),
  release: vi.fn(),
}));

vi.mock('@roomote/db/server', () => ({
  claimCanonicalPrReviewAction: mocks.claim,
  completeCanonicalPrReviewActionDispatch: mocks.complete,
  releaseCanonicalPrReviewActionDispatch: mocks.release,
}));

vi.mock('@roomote/sdk/server', () => ({
  dispatchPrReviewFollowUp: mocks.dispatch,
}));

import { handleWebPrReviewAction } from './pr-review-actions';

const deliveryId = '11111111-1111-4111-8111-111111111111';
const getOfferStatus = vi.fn();
const updateOfferStatus = vi.fn();

function handle(choice: 'yes' | 'auto' | 'dismiss' = 'yes') {
  return handleWebPrReviewAction({
    deliveryId,
    choice,
    actingUserId: 'user-1',
    expectedDestinationKind: 'task',
    expectedDestinationKey: 'task-1',
    getOfferStatus,
    updateOfferStatus,
  });
}

describe('handleWebPrReviewAction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    updateOfferStatus.mockResolvedValue(undefined);
    getOfferStatus.mockResolvedValue(null);
    mocks.complete.mockResolvedValue(true);
    mocks.release.mockResolvedValue(true);
  });

  it('dispatches and completes a claimed offer', async () => {
    mocks.claim.mockResolvedValue({
      taskId: 'task-1',
      followUpPrompt: 'Resolve the feedback.',
    });
    mocks.dispatch.mockResolvedValue({ outcome: 'queued', runId: 42 });

    await expect(handle()).resolves.toEqual({ status: 'resolved' });

    expect(mocks.claim).toHaveBeenCalledWith({
      deliveryId,
      choice: 'yes',
      actingUserId: 'user-1',
      expectedDestinationKind: 'task',
      expectedDestinationKey: 'task-1',
    });
    expect(mocks.dispatch).toHaveBeenCalledWith({
      provider: 'web',
      taskId: 'task-1',
      followUpPrompt: 'Resolve the feedback.',
      actingUserId: 'user-1',
      idempotencyKey: `pr-review-delivery:${deliveryId}`,
    });
    expect(mocks.complete).toHaveBeenCalledWith({ deliveryId, runId: 42 });
    expect(updateOfferStatus).toHaveBeenCalledWith('resolved');
  });

  it('persists the auto-resolve terminal state through the same lifecycle', async () => {
    mocks.claim.mockResolvedValue({
      taskId: 'task-1',
      followUpPrompt: 'Resolve the feedback.',
    });
    mocks.dispatch.mockResolvedValue({ outcome: 'resumed', runId: 43 });

    await expect(handle('auto')).resolves.toEqual({
      status: 'auto_resolved',
    });
    expect(updateOfferStatus).toHaveBeenCalledWith('auto_resolved');
  });

  it('dismisses without dispatching', async () => {
    mocks.claim.mockResolvedValue({
      taskId: 'task-1',
      followUpPrompt: 'Resolve the feedback.',
    });

    await expect(handle('dismiss')).resolves.toEqual({
      status: 'dismissed',
    });
    expect(mocks.dispatch).not.toHaveBeenCalled();
    expect(updateOfferStatus).toHaveBeenCalledWith('dismissed');
  });

  it('releases a malformed claim instead of leaving it stuck', async () => {
    mocks.claim.mockResolvedValue({ taskId: null, followUpPrompt: null });

    await expect(handle()).rejects.toThrow(
      'Claimed review action is missing its dispatch target',
    );
    expect(mocks.release).toHaveBeenCalledWith(deliveryId);
    expect(mocks.dispatch).not.toHaveBeenCalled();
  });

  it('preserves durable state when another request won the claim', async () => {
    mocks.claim.mockResolvedValue(null);
    getOfferStatus.mockResolvedValue('dismissed');

    await expect(handle()).resolves.toEqual({ status: 'dismissed' });
    expect(mocks.dispatch).not.toHaveBeenCalled();
    expect(getOfferStatus).toHaveBeenCalledOnce();
    expect(updateOfferStatus).not.toHaveBeenCalled();
  });

  it('returns stale without persisting when a lost claim has no transcript state', async () => {
    mocks.claim.mockResolvedValue(null);

    await expect(handle()).resolves.toEqual({ status: 'stale' });
    expect(updateOfferStatus).not.toHaveBeenCalled();
  });

  it('releases an unavailable dispatch for retry', async () => {
    mocks.claim.mockResolvedValue({
      taskId: 'task-1',
      followUpPrompt: 'Resolve the feedback.',
    });
    mocks.dispatch.mockResolvedValue({ outcome: 'unavailable' });

    await expect(handle()).resolves.toEqual({ status: 'pending' });
    expect(mocks.release).toHaveBeenCalledWith(deliveryId);
    expect(mocks.complete).not.toHaveBeenCalled();
    expect(updateOfferStatus).toHaveBeenCalledWith('pending');
  });

  it('does not overwrite state when an unavailable dispatch loses its release', async () => {
    mocks.claim.mockResolvedValue({
      taskId: 'task-1',
      followUpPrompt: 'Resolve the feedback.',
    });
    mocks.dispatch.mockResolvedValue({ outcome: 'unavailable' });
    mocks.release.mockResolvedValue(false);

    await expect(handle()).resolves.toEqual({ status: 'stale' });
    expect(updateOfferStatus).not.toHaveBeenCalled();
  });

  it('releases a thrown dispatch so the offer can be retried', async () => {
    const dispatchError = new Error('dispatch failed');
    mocks.claim.mockResolvedValue({
      taskId: 'task-1',
      followUpPrompt: 'Resolve the feedback.',
    });
    mocks.dispatch.mockRejectedValue(dispatchError);

    await expect(handle()).rejects.toBe(dispatchError);
    expect(mocks.release).toHaveBeenCalledWith(deliveryId);
    expect(updateOfferStatus).toHaveBeenCalledWith('pending');
    expect(mocks.complete).not.toHaveBeenCalled();
  });
});
