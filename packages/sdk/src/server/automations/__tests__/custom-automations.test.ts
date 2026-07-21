import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@roomote/cloud-agents/server', () => ({
  enqueueTask: vi.fn(),
}));

vi.mock('@roomote/db/server', () => ({
  db: {
    query: {
      environments: { findFirst: vi.fn() },
      slackInstallations: { findFirst: vi.fn() },
    },
  },
  environments: {},
  eq: vi.fn((...args: unknown[]) => args),
  getCustomAutomationById: vi.fn(),
  getCustomAutomationFrequency: vi.fn(),
  listEnabledCustomAutomations: vi.fn(),
  recordCustomAutomationRunOutcome: vi.fn(),
  releaseCustomAutomationLaunchClaim: vi.fn(),
  tryClaimCustomAutomationLaunch: vi.fn(),
  slackInstallations: {},
}));

vi.mock('../destination', () => ({
  buildDestinationTaskPayloadFields: vi.fn(() => ({})),
  findTeamsConversationServiceUrl: vi.fn(),
  listConnectedCommunicationProviders: vi.fn(async () => ['slack', 'teams']),
}));

vi.mock('../scheduling-utils', () => ({
  isRunDue: vi.fn(),
  resolveSlackWorkspaceTimezone: vi.fn(async () => 'UTC'),
}));

import { enqueueTask } from '@roomote/cloud-agents/server';
import {
  db,
  getCustomAutomationById,
  getCustomAutomationFrequency,
  listEnabledCustomAutomations,
  recordCustomAutomationRunOutcome,
  releaseCustomAutomationLaunchClaim,
  tryClaimCustomAutomationLaunch,
} from '@roomote/db/server';
import { TaskPayloadKind } from '@roomote/types';

import {
  customAutomationsJob,
  runCustomAutomationNow,
} from '../custom-automations';
import {
  buildDestinationTaskPayloadFields,
  findTeamsConversationServiceUrl,
} from '../destination';
import { isRunDue } from '../scheduling-utils';

const automation = {
  id: '11111111-1111-1111-1111-111111111111',
  name: 'Flaky tests',
  prompt: 'Find flaky tests and propose fixes.',
  enabled: true,
  scheduleMode: 'daily',
  environmentId: '22222222-2222-2222-2222-222222222222',
  target: {
    provider: 'slack',
    targetKind: 'slack_channel',
    externalRef: 'C123',
  },
  createdByUserId: null,
  lastRunAt: null,
  lastSucceededAt: null,
  lastFailedAt: null,
  lastError: null,
  lastLaunchedTaskId: null,
  launchClaimedAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

describe('customAutomationsJob', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(listEnabledCustomAutomations).mockResolvedValue([
      automation as never,
    ]);
    vi.mocked(getCustomAutomationFrequency).mockReturnValue('daily');
    vi.mocked(tryClaimCustomAutomationLaunch).mockResolvedValue(new Date());
    vi.mocked(isRunDue).mockReturnValue(true);
    vi.mocked(db.query.environments.findFirst).mockResolvedValue({
      id: automation.environmentId,
    } as never);
    vi.mocked(db.query.slackInstallations.findFirst).mockResolvedValue(
      undefined,
    );
    vi.mocked(enqueueTask).mockResolvedValue({
      taskId: 'task_abc',
    } as never);
  });

  it('launches a StandardTask for due automations', async () => {
    const result = await customAutomationsJob();

    expect(result.launchedTaskId).toBe('task_abc');
    expect(tryClaimCustomAutomationLaunch).toHaveBeenCalledWith(automation.id);
    expect(isRunDue).toHaveBeenCalledWith(
      expect.objectContaining({
        frequency: 'daily',
        scheduleHourLocal: 3,
      }),
    );
    expect(enqueueTask).toHaveBeenCalledWith(
      expect.objectContaining({
        task: expect.objectContaining({
          type: TaskPayloadKind.StandardTask,
          payload: expect.objectContaining({
            environmentId: automation.environmentId,
            description: automation.prompt,
            repo: '',
          }),
        }),
        initiator: {
          kind: 'automation',
          key: 'custom_automation',
          actor: {
            externalId: automation.id,
            displayName: automation.name,
          },
        },
        title: automation.name,
        workflow: 'standard',
        surface: 'system',
        trigger: 'schedule',
        channels: { slackChannelId: 'C123' },
      }),
    );
    expect(recordCustomAutomationRunOutcome).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        id: automation.id,
        status: 'succeeded',
        lastLaunchedTaskId: 'task_abc',
      }),
    );
  });

  it('uses hour-0 boundary for hourly schedules', async () => {
    vi.mocked(getCustomAutomationFrequency).mockReturnValue('every_hour');

    await customAutomationsJob();

    expect(isRunDue).toHaveBeenCalledWith(
      expect.objectContaining({
        frequency: 'every_hour',
        scheduleHourLocal: 0,
      }),
    );
  });

  it('skips when another launcher already claimed the row', async () => {
    vi.mocked(tryClaimCustomAutomationLaunch).mockResolvedValue(null);

    const result = await customAutomationsJob();

    expect(result.launchedTaskId).toBeNull();
    expect(enqueueTask).not.toHaveBeenCalled();
  });

  it('skips when not due', async () => {
    vi.mocked(isRunDue).mockReturnValue(false);

    const result = await customAutomationsJob();

    expect(result.launchedTaskId).toBeNull();
    expect(tryClaimCustomAutomationLaunch).not.toHaveBeenCalled();
    expect(enqueueTask).not.toHaveBeenCalled();
  });

  it('resolves Teams service URL before launch', async () => {
    vi.mocked(listEnabledCustomAutomations).mockResolvedValue([
      {
        ...automation,
        target: {
          provider: 'teams',
          targetKind: 'teams_channel',
          externalRef: '19:abc@thread.tacv2',
        },
      } as never,
    ]);
    vi.mocked(findTeamsConversationServiceUrl).mockResolvedValue(
      'https://smba.trafficmanager.net/amer/',
    );
    vi.mocked(buildDestinationTaskPayloadFields).mockReturnValue({
      communicationProvider: 'teams',
      communicationChannelId: '19:abc@thread.tacv2',
      communicationServiceUrl: 'https://smba.trafficmanager.net/amer/',
    });

    const result = await customAutomationsJob();

    expect(result.launchedTaskId).toBe('task_abc');
    expect(findTeamsConversationServiceUrl).toHaveBeenCalledWith(
      '19:abc@thread.tacv2',
    );
    expect(enqueueTask).toHaveBeenCalledWith(
      expect.objectContaining({
        task: expect.objectContaining({
          payload: expect.objectContaining({
            communicationServiceUrl: 'https://smba.trafficmanager.net/amer/',
          }),
        }),
      }),
    );
  });

  it('fails Teams launch when service URL cannot be resolved', async () => {
    vi.mocked(listEnabledCustomAutomations).mockResolvedValue([
      {
        ...automation,
        target: {
          provider: 'teams',
          targetKind: 'teams_channel',
          externalRef: '19:abc@thread.tacv2',
        },
      } as never,
    ]);
    vi.mocked(findTeamsConversationServiceUrl).mockResolvedValue(null);

    const result = await customAutomationsJob();

    expect(result.launchedTaskId).toBeNull();
    expect(enqueueTask).not.toHaveBeenCalled();
    expect(recordCustomAutomationRunOutcome).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        status: 'failed',
        error: expect.stringContaining('service URL'),
      }),
    );
  });
});

describe('runCustomAutomationNow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getCustomAutomationById).mockResolvedValue(automation as never);
    vi.mocked(getCustomAutomationFrequency).mockReturnValue('daily');
    vi.mocked(tryClaimCustomAutomationLaunch).mockResolvedValue(new Date());
    vi.mocked(db.query.environments.findFirst).mockResolvedValue({
      id: automation.environmentId,
    } as never);
    vi.mocked(enqueueTask).mockResolvedValue({
      taskId: 'task_manual',
    } as never);
  });

  it('launches with manual trigger', async () => {
    const result = await runCustomAutomationNow(automation.id);

    expect(result).toEqual({
      outcome: 'launched',
      taskId: 'task_manual',
    });
    expect(enqueueTask).toHaveBeenCalledWith(
      expect.objectContaining({
        trigger: 'manual',
      }),
    );
  });

  it('skips manual run when claim fails because previous task is active', async () => {
    vi.mocked(tryClaimCustomAutomationLaunch).mockResolvedValue(null);

    const result = await runCustomAutomationNow(automation.id);

    expect(result).toEqual({
      outcome: 'skipped',
      reason: 'Previous run is still active.',
    });
    expect(enqueueTask).not.toHaveBeenCalled();
  });

  it('releases the launch claim when enqueue fails', async () => {
    const claimAt = new Date('2026-07-21T00:00:00.000Z');
    vi.mocked(tryClaimCustomAutomationLaunch).mockResolvedValue(claimAt);
    vi.mocked(enqueueTask).mockRejectedValue(new Error('queue down'));

    const result = await runCustomAutomationNow(automation.id);

    expect(result.outcome).toBe('failed');
    expect(releaseCustomAutomationLaunchClaim).toHaveBeenCalledWith(
      automation.id,
      claimAt,
    );
  });

  it('fails when automation is disabled', async () => {
    vi.mocked(getCustomAutomationById).mockResolvedValue({
      ...automation,
      enabled: false,
    } as never);

    const result = await runCustomAutomationNow(automation.id);

    expect(result.outcome).toBe('failed');
    expect(enqueueTask).not.toHaveBeenCalled();
  });
});
