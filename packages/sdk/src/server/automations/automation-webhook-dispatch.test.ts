const mocks = vi.hoisted(() => ({
  claim: vi.fn(),
  reconcile: vi.fn(),
  retry: vi.fn(),
  getAutomation: vi.fn(),
  authorize: vi.fn(),
  loadNote: vi.fn(),
  launch: vi.fn(),
  running: vi.fn(),
  cleanup: vi.fn(),
  flagStalled: vi.fn(),
  settle: vi.fn(),
  acquireLock: vi.fn(),
  releaseLock: vi.fn(),
}));

vi.mock('@roomote/db/server', () => ({
  db: {
    select: () => ({
      from: () => ({
        innerJoin: () => ({ where: () => ({ limit: mocks.running }) }),
      }),
    }),
  },
  automationWebhookDeliveries: {
    id: 'deliveryId',
    sessionId: 'sessionId',
    status: 'status',
  },
  fastAgentParentEvents: {
    parent: 'parent',
    conversationId: 'conversationId',
    event: 'event',
  },
  and: vi.fn(),
  eq: vi.fn(),
  sql: vi.fn(),
  cleanupAutomationWebhookDeliveries: mocks.cleanup,
  flagStalledAutomationWebhookDeliveries: mocks.flagStalled,
  settleRunningAutomationWebhookDeliveryForSession: mocks.settle,
  claimAutomationWebhookDelivery: mocks.claim,
  reconcileExhaustedAutomationWebhookDeliveries: mocks.reconcile,
  retryAutomationWebhookDelivery: mocks.retry,
  getCustomAutomationById: mocks.getAutomation,
}));
vi.mock('@roomote/cloud-agents/server', () => ({
  acquireFastAgentTurnLock: mocks.acquireLock,
}));
vi.mock('./automation-webhooks', () => ({
  assertWebhookTriggerAuthorized: mocks.authorize,
  loadGranolaWebhookNote: mocks.loadNote,
}));
vi.mock('./custom-automations', () => ({
  launchCustomAutomationRow: mocks.launch,
}));

import { processAutomationWebhookDeliveries } from './automation-webhook-dispatch';

const delivery = {
  id: 'delivery-1',
  triggerId: 'trigger-1',
  automationId: 'automation-1',
  noteId: 'note-1',
  leaseToken: 'lease-1',
};
const automation = {
  id: 'automation-1',
  enabled: true,
  createdByUserId: 'user-1',
};

describe('automation webhook dispatcher', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.running.mockResolvedValue([]);
    mocks.acquireLock.mockResolvedValue(mocks.releaseLock);
    mocks.claim.mockResolvedValue(null).mockResolvedValueOnce(delivery);
    mocks.getAutomation.mockResolvedValue(automation);
    mocks.loadNote.mockResolvedValue('Meeting summary');
    mocks.launch.mockResolvedValue({ queued: true, errors: [] });
  });

  it('reconciles running execution only under the Fast turn lock, then flags and cleans up', async () => {
    const parent = {
      sessionId: 'session-1',
      conversation: {
        surface: 'automation',
        workspaceId: 'automation-1',
        conversationId: 'event-1',
      },
    };
    mocks.running.mockResolvedValue([{ parent }]);
    await processAutomationWebhookDeliveries();
    expect(mocks.acquireLock).toHaveBeenCalledWith({
      conversation: parent.conversation,
      maxWaitMs: 0,
    });
    expect(mocks.settle).toHaveBeenCalledWith(parent.sessionId);
    expect(mocks.releaseLock).toHaveBeenCalledOnce();
    expect(mocks.flagStalled).toHaveBeenCalledOnce();
    expect(mocks.cleanup).toHaveBeenCalledOnce();
  });

  it('does not reconcile a running session while its Fast turn is busy', async () => {
    mocks.running.mockResolvedValue([
      { parent: { sessionId: 'session-1', conversation: {} } },
    ]);
    mocks.acquireLock.mockResolvedValue(null);
    await processAutomationWebhookDeliveries();
    expect(mocks.settle).not.toHaveBeenCalled();
    expect(mocks.releaseLock).not.toHaveBeenCalled();
  });

  it('releases the turn lock on reconciliation failure without dispatching blindly', async () => {
    mocks.running.mockResolvedValue([
      { parent: { sessionId: 'session-1', conversation: {} } },
    ]);
    mocks.settle.mockRejectedValue(new Error('Database unavailable'));
    await expect(processAutomationWebhookDeliveries()).rejects.toThrow(
      'Database unavailable',
    );
    expect(mocks.releaseLock).toHaveBeenCalledOnce();
    expect(mocks.claim).not.toHaveBeenCalled();
  });

  it('reconciles exhausted retries before claiming and bounds each wakeup to 20 deliveries', async () => {
    mocks.claim.mockReset().mockResolvedValue(delivery);
    await processAutomationWebhookDeliveries();
    expect(mocks.reconcile).toHaveBeenCalledOnce();
    expect(mocks.reconcile.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.claim.mock.invocationCallOrder[0]!,
    );
    expect(mocks.claim).toHaveBeenCalledTimes(20);
    expect(mocks.launch).toHaveBeenCalledTimes(20);
  });

  it('does not retry queued work and passes a bounded note and the claimed lease', async () => {
    mocks.loadNote.mockResolvedValue('x'.repeat(50_001));
    await processAutomationWebhookDeliveries();
    expect(mocks.launch).toHaveBeenCalledWith(automation, {
      webhook: {
        deliveryId: delivery.id,
        triggerId: delivery.triggerId,
        leaseToken: delivery.leaseToken,
        untrustedNoteSummary: 'x'.repeat(50_000),
      },
    });
    expect(mocks.authorize).toHaveBeenCalledTimes(2);
    expect(mocks.loadNote).toHaveBeenCalledWith(
      delivery.triggerId,
      delivery.noteId,
    );
    expect(mocks.retry).not.toHaveBeenCalled();
    expect(mocks.claim).toHaveBeenCalledTimes(2);
  });

  it('refunds the attempt when the automation is busy', async () => {
    mocks.launch.mockResolvedValue({
      queued: false,
      errors: [],
      skippedReason: 'Another launch is already in progress.',
    });
    await processAutomationWebhookDeliveries();
    expect(mocks.retry).toHaveBeenCalledWith(
      delivery.id,
      delivery.leaseToken,
      'Another launch is already in progress.',
      true,
    );
  });

  it('retries launch errors without refunding the attempt', async () => {
    mocks.launch.mockResolvedValue({
      queued: false,
      errors: ['first', 'second'],
    });
    await processAutomationWebhookDeliveries();
    expect(mocks.retry).toHaveBeenCalledWith(
      delivery.id,
      delivery.leaseToken,
      'first; second',
      false,
    );
  });

  it('does not fetch the note or launch when authorization fails', async () => {
    mocks.authorize.mockRejectedValue(new Error('Unauthorized'));
    await processAutomationWebhookDeliveries();
    expect(mocks.getAutomation).not.toHaveBeenCalled();
    expect(mocks.loadNote).not.toHaveBeenCalled();
    expect(mocks.launch).not.toHaveBeenCalled();
    expect(mocks.retry).toHaveBeenCalledWith(
      delivery.id,
      delivery.leaseToken,
      'Unauthorized',
    );
  });

  it('rechecks authorization after fetching the note', async () => {
    mocks.authorize
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('Revoked'));
    await processAutomationWebhookDeliveries();
    expect(mocks.loadNote).toHaveBeenCalledOnce();
    expect(mocks.launch).not.toHaveBeenCalled();
    expect(mocks.retry).toHaveBeenCalledWith(
      delivery.id,
      delivery.leaseToken,
      'Revoked',
    );
  });
});
