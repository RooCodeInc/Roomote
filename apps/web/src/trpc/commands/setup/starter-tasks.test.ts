import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockAssertAdmin,
  mockCompleteSetup,
  mockStartFastSession,
  mockCaptureEvent,
} = vi.hoisted(() => ({
  mockAssertAdmin: vi.fn(),
  mockCompleteSetup: vi.fn(),
  mockStartFastSession: vi.fn(),
  mockCaptureEvent: vi.fn(),
}));

vi.mock('./shared', () => ({
  assertAdmin: (...args: unknown[]) => mockAssertAdmin(...args),
}));

vi.mock('./index', () => ({
  completeSetupCommand: (...args: unknown[]) => mockCompleteSetup(...args),
}));

vi.mock('../fast-sessions', () => ({
  startFastSessionCommand: (...args: unknown[]) =>
    mockStartFastSession(...args),
}));

vi.mock('@roomote/telemetry/server', () => ({
  captureEvent: (...args: unknown[]) => mockCaptureEvent(...args),
}));

import type { UserAuthSuccess } from '@/types';
import { getSetupStarterTask } from '@/lib/setup-starter-tasks';
import { completeSetupWithStarterTasksCommand } from './starter-tasks';

function buildAuth(overrides: Partial<UserAuthSuccess> = {}): UserAuthSuccess {
  return {
    success: true,
    userType: 'user',
    userId: 'admin-1',
    name: 'Admin',
    primaryEmail: 'admin@example.com',
    isAdmin: true,
    anonymousAnalyticsEnabled: false,
    cloudEnabled: false,
    resource: {
      username: null,
      fullName: null,
      firstName: null,
      lastName: null,
      primaryEmailAddress: null,
      emailAddresses: [],
      imageUrl: '',
      createdAt: null,
    },
    ...overrides,
  } as UserAuthSuccess;
}

describe('completeSetupWithStarterTasksCommand', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCompleteSetup.mockResolvedValue({ success: true });
    mockStartFastSession.mockImplementation(
      async (_auth: unknown, input: { text: string }) => ({
        sessionId: `session-for:${input.text.slice(0, 20)}`,
      }),
    );
  });

  it('starts a Session for each selected starter prompt and completes setup', async () => {
    mockStartFastSession
      .mockResolvedValueOnce({ sessionId: 'session-ci' })
      .mockResolvedValueOnce({ sessionId: 'session-security' });

    const result = await completeSetupWithStarterTasksCommand(buildAuth(), {
      launchBatchId: '11111111-1111-4111-8111-111111111111',
      selectedStarterTaskIds: ['speed-up-ci', 'security-scan'],
      anonymousAnalyticsEnabled: true,
      productUpdatesEnabled: false,
    });

    expect(mockAssertAdmin).toHaveBeenCalledOnce();
    expect(mockStartFastSession).toHaveBeenCalledTimes(2);
    expect(mockStartFastSession).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ userId: 'admin-1' }),
      {
        text: getSetupStarterTask('speed-up-ci').prompt,
        conversationId:
          'setup-starter:11111111-1111-4111-8111-111111111111:speed-up-ci',
      },
    );
    expect(mockStartFastSession).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ userId: 'admin-1' }),
      {
        text: getSetupStarterTask('security-scan').prompt,
        conversationId:
          'setup-starter:11111111-1111-4111-8111-111111111111:security-scan',
      },
    );
    expect(mockCompleteSetup).toHaveBeenCalledWith(expect.anything(), {
      anonymousAnalyticsEnabled: true,
      productUpdatesEnabled: false,
    });
    expect(result).toEqual({
      launched: [
        { starterTaskId: 'speed-up-ci', sessionId: 'session-ci' },
        { starterTaskId: 'security-scan', sessionId: 'session-security' },
      ],
      failed: [],
      setupCompleted: true,
      completionError: null,
    });
    expect(mockCaptureEvent).toHaveBeenCalledWith(
      'setup_starter_tasks_submitted',
      {
        userId: 'admin-1',
        properties: {
          selectedCount: 2,
          launchedCount: 2,
          failedCount: 0,
          starterTaskIds: 'speed-up-ci,security-scan',
        },
      },
    );
  });

  it('deduplicates repeated starter task ids', async () => {
    const result = await completeSetupWithStarterTasksCommand(buildAuth(), {
      launchBatchId: '11111111-1111-4111-8111-111111111111',
      selectedStarterTaskIds: ['speed-up-ci', 'speed-up-ci'],
    });

    expect(mockStartFastSession).toHaveBeenCalledTimes(1);
    expect(result.launched).toHaveLength(1);
  });

  it('keeps setup incomplete and reports failures when a Session fails to start', async () => {
    mockStartFastSession
      .mockResolvedValueOnce({ sessionId: 'session-ci' })
      .mockRejectedValueOnce(new Error('session startup failed'));

    const result = await completeSetupWithStarterTasksCommand(buildAuth(), {
      launchBatchId: '11111111-1111-4111-8111-111111111111',
      selectedStarterTaskIds: ['speed-up-ci', 'security-scan'],
    });

    expect(mockCompleteSetup).not.toHaveBeenCalled();
    expect(result).toEqual({
      launched: [{ starterTaskId: 'speed-up-ci', sessionId: 'session-ci' }],
      failed: [
        { starterTaskId: 'security-scan', error: 'session startup failed' },
      ],
      setupCompleted: false,
      completionError: null,
    });
  });

  it('completes setup without launching anything for an empty selection', async () => {
    const result = await completeSetupWithStarterTasksCommand(buildAuth(), {
      launchBatchId: '11111111-1111-4111-8111-111111111111',
      selectedStarterTaskIds: [],
      productUpdatesEnabled: true,
    });

    expect(mockStartFastSession).not.toHaveBeenCalled();
    expect(mockCompleteSetup).toHaveBeenCalledWith(expect.anything(), {
      productUpdatesEnabled: true,
    });
    expect(result).toEqual({
      launched: [],
      failed: [],
      setupCompleted: true,
      completionError: null,
    });
  });

  it('reports a completion error without losing launched Sessions', async () => {
    mockCompleteSetup.mockRejectedValueOnce(new Error('settings write failed'));

    const result = await completeSetupWithStarterTasksCommand(buildAuth(), {
      launchBatchId: '11111111-1111-4111-8111-111111111111',
      selectedStarterTaskIds: ['fix-test-flakes'],
    });

    expect(result.launched).toHaveLength(1);
    expect(result.failed).toEqual([]);
    expect(result.setupCompleted).toBe(false);
    expect(result.completionError).toBe('settings write failed');
  });
});
