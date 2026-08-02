import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  createCustomAutomationWrite,
  updateCustomAutomationWrite,
  assertAdmin,
} = vi.hoisted(() => ({
  createCustomAutomationWrite: vi.fn(),
  updateCustomAutomationWrite: vi.fn(),
  assertAdmin: vi.fn(),
}));

vi.mock('@roomote/db/server', () => ({
  deleteCustomAutomation: vi.fn(),
  getCustomAutomationById: vi.fn(),
  listCustomAutomations: vi.fn(),
}));

vi.mock('@roomote/sdk/server', () => ({
  createCustomAutomationWrite,
  resolveCustomAutomationSchedule: vi.fn(),
  runCustomAutomationNow: vi.fn(),
  updateCustomAutomationWrite,
}));

vi.mock('./feature-gates', () => ({ assertAdmin }));

import {
  createCustomAutomationCommand,
  updateCustomAutomationCommand,
} from './custom-automations';

const automation = {
  id: 'automation-1',
  name: 'Daily scan',
  prompt: 'Scan the repository.',
  enabled: true,
  scheduleMode: 'daily',
  cronExpression: null,
  model: null,
  environmentId: '00000000-0000-0000-0000-000000000001',
  target: {},
  lastRunAt: null,
  lastSucceededAt: null,
  lastFailedAt: null,
  lastError: null,
  lastLaunchedTaskId: null,
  createdByUserId: 'user-1',
  launchClaimedAt: null,
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  updatedAt: new Date('2026-01-01T00:00:00.000Z'),
};

const input = {
  name: automation.name,
  prompt: automation.prompt,
  enabled: true,
  scheduleMode: 'daily',
  cronExpression: null,
  model: null,
  environmentId: automation.environmentId,
  targetProvider: 'slack' as const,
  targetChannelId: 'C123',
};

describe('custom automation commands', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    createCustomAutomationWrite.mockResolvedValue({
      status: 'saved',
      automation,
      resolution: null,
    });
    updateCustomAutomationWrite.mockResolvedValue({
      status: 'saved',
      automation,
      resolution: null,
    });
  });

  it('adapts web create input to the owning write service', async () => {
    await createCustomAutomationCommand({ userId: 'user-1' } as never, input);

    expect(createCustomAutomationWrite).toHaveBeenCalledWith({
      name: automation.name,
      prompt: automation.prompt,
      enabled: true,
      model: null,
      environmentId: automation.environmentId,
      schedule: { scheduleMode: 'daily', cronExpression: null },
      target: { provider: 'slack', channelId: 'C123' },
      createdByUserId: 'user-1',
    });
  });

  it('adapts a destination-free web update as an explicit clear', async () => {
    await updateCustomAutomationCommand({ userId: 'user-1' } as never, {
      ...input,
      id: automation.id,
      targetProvider: undefined,
    });

    expect(updateCustomAutomationWrite).toHaveBeenCalledWith(
      automation.id,
      expect.objectContaining({ target: null }),
    );
  });

  it('preserves typed write errors from the owning service', async () => {
    const error = Object.assign(
      new Error('Model must use provider/model format.'),
      { code: 'invalid_input' },
    );
    createCustomAutomationWrite.mockRejectedValue(error);

    await expect(
      createCustomAutomationCommand({ userId: 'user-1' } as never, {
        ...input,
        model: 'no-provider-prefix',
      }),
    ).rejects.toBe(error);
  });
});
