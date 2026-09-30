import type { Job } from 'bullmq';

const { getWebhookStateMock, matchesTokenMock, runAutomationMock } = vi.hoisted(
  () => ({
    getWebhookStateMock: vi.fn(),
    matchesTokenMock: vi.fn(),
    runAutomationMock: vi.fn(),
  }),
);

vi.mock('@roomote/db/server', () => ({
  getBackgroundAutomationWebhookState: getWebhookStateMock,
}));

vi.mock('@roomote/sdk/server', () => ({
  BUILT_IN_AUTOMATION_WEBHOOK_QUEUE_NAME: 'built-in-automation-webhooks',
  builtInAutomationWebhookJobSchema: {
    parse: (value: unknown) => value,
  },
  matchesBuiltInAutomationWebhookToken: matchesTokenMock,
  runAutomationNow: runAutomationMock,
}));

import { processBuiltInAutomationWebhookJob } from './built-in-automation-webhooks-queue';

const jobData = {
  automationKey: 'suggester' as const,
  webhookInputJson: '{"issue":"test"}',
  webhookTokenDigest: 'digest',
};

describe('processBuiltInAutomationWebhookJob', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getWebhookStateMock.mockResolvedValue({ enabled: true, token: 'current' });
    matchesTokenMock.mockReturnValue(true);
    runAutomationMock.mockResolvedValue({ outcome: 'queued' });
  });

  it('drops a queued job after webhook disablement', async () => {
    getWebhookStateMock.mockResolvedValue({ enabled: false, token: 'current' });

    await processBuiltInAutomationWebhookJob({
      id: 'job-1',
      data: jobData,
    } as Job<typeof jobData>);

    expect(runAutomationMock).not.toHaveBeenCalled();
  });

  it('drops a queued job after webhook token rotation', async () => {
    matchesTokenMock.mockReturnValue(false);

    await processBuiltInAutomationWebhookJob({
      id: 'job-1',
      data: jobData,
    } as Job<typeof jobData>);

    expect(runAutomationMock).not.toHaveBeenCalled();
  });

  it('runs an admitted job when the current credential still matches', async () => {
    await processBuiltInAutomationWebhookJob({
      id: 'job-1',
      data: jobData,
    } as Job<typeof jobData>);

    expect(matchesTokenMock).toHaveBeenCalledWith('digest', 'current');
    expect(runAutomationMock).toHaveBeenCalledWith('suggester', {
      trigger: 'webhook',
      webhookInputJson: '{"issue":"test"}',
    });
  });
});
