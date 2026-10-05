const { mockQueueAdd } = vi.hoisted(() => ({
  mockQueueAdd: vi.fn(),
}));

vi.mock('bullmq', () => ({
  Queue: class {
    add = mockQueueAdd;
  },
}));

vi.mock('@roomote/redis', () => ({
  getRedis: vi.fn(() => ({ status: 'ready' })),
}));

import {
  BUILT_IN_AUTOMATION_WEBHOOK_QUEUE_NAME,
  enqueueBuiltInAutomationWebhook,
  hashBuiltInAutomationWebhookToken,
} from '../built-in-automation-webhook';

describe('enqueueBuiltInAutomationWebhook', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockQueueAdd.mockResolvedValue(undefined);
  });

  it('admits a validated webhook run to the durable queue', async () => {
    await enqueueBuiltInAutomationWebhook({
      automationKey: 'suggester',
      webhookInputJson: '{"issue":"test"}',
      webhookToken: 'A'.repeat(43),
    });

    expect(mockQueueAdd).toHaveBeenCalledWith('run', {
      automationKey: 'suggester',
      webhookInputJson: '{"issue":"test"}',
      webhookTokenDigest: hashBuiltInAutomationWebhookToken('A'.repeat(43)),
    });
  });

  it('rejects automation keys without a public webhook descriptor', async () => {
    await expect(
      enqueueBuiltInAutomationWebhook({
        automationKey: 'review_code' as never,
        webhookInputJson: null,
        webhookToken: 'A'.repeat(43),
      }),
    ).rejects.toThrow();
    expect(mockQueueAdd).not.toHaveBeenCalled();
  });

  it('uses the dedicated queue name', async () => {
    expect(BUILT_IN_AUTOMATION_WEBHOOK_QUEUE_NAME).toBe(
      'built-in-automation-webhooks',
    );
  });
});
