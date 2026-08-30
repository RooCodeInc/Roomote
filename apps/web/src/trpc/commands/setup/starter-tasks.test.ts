import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockAssertAdmin,
  mockCompleteSetup,
  mockStartSetupFastSession,
  mockCaptureEvent,
} = vi.hoisted(() => ({
  mockAssertAdmin: vi.fn(),
  mockCompleteSetup: vi.fn(),
  mockStartSetupFastSession: vi.fn(),
  mockCaptureEvent: vi.fn(),
}));

vi.mock('./shared', () => ({
  assertAdmin: (...args: unknown[]) => mockAssertAdmin(...args),
}));

vi.mock('./index', () => ({
  completeSetupCommand: (...args: unknown[]) => mockCompleteSetup(...args),
}));

vi.mock('../fast-sessions', () => ({
  startSetupFastSessionCommand: (...args: unknown[]) =>
    mockStartSetupFastSession(...args),
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
    mockStartSetupFastSession.mockResolvedValue({
      sessionId: 'setup-session-1',
      created: true,
    });
  });

  it('completes setup first, then starts one setup session carrying the selected starter tasks', async () => {
    const result = await completeSetupWithStarterTasksCommand(buildAuth(), {
      launchBatchId: '11111111-1111-4111-8111-111111111111',
      selectedStarterTaskIds: ['speed-up-ci', 'security-scan'],
      anonymousAnalyticsEnabled: true,
      productUpdatesEnabled: false,
    });

    expect(mockAssertAdmin).toHaveBeenCalledOnce();
    expect(mockCompleteSetup).toHaveBeenCalledWith(expect.anything(), {
      anonymousAnalyticsEnabled: true,
      productUpdatesEnabled: false,
    });
    expect(mockCompleteSetup.mock.invocationCallOrder[0]).toBeLessThan(
      mockStartSetupFastSession.mock.invocationCallOrder[0] ?? Infinity,
    );
    expect(mockStartSetupFastSession).toHaveBeenCalledTimes(1);
    expect(mockStartSetupFastSession).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'admin-1' }),
      {
        conversationId: 'setup-session:11111111-1111-4111-8111-111111111111',
        title: 'Set up Roomote',
        event: expect.objectContaining({
          type: 'setup_session_started',
          adminName: 'Admin',
          starterTasks: [
            expect.objectContaining({
              id: 'speed-up-ci',
              prompt: getSetupStarterTask('speed-up-ci').prompt,
            }),
            expect.objectContaining({
              id: 'security-scan',
              prompt: getSetupStarterTask('security-scan').prompt,
            }),
          ],
        }),
      },
    );
    expect(result).toEqual({
      sessionId: 'setup-session-1',
      setupCompleted: true,
      completionError: null,
    });
    expect(mockCaptureEvent).toHaveBeenCalledWith(
      'setup_starter_tasks_submitted',
      {
        userId: 'admin-1',
        properties: {
          selectedCount: 2,
          starterTaskIds: 'speed-up-ci,security-scan',
          setupSessionCreated: true,
        },
      },
    );
  });

  it('deduplicates repeated starter task ids', async () => {
    await completeSetupWithStarterTasksCommand(buildAuth(), {
      launchBatchId: '11111111-1111-4111-8111-111111111111',
      selectedStarterTaskIds: ['speed-up-ci', 'speed-up-ci'],
    });

    expect(mockStartSetupFastSession).toHaveBeenCalledTimes(1);
    const [, input] = mockStartSetupFastSession.mock.calls[0] as [
      unknown,
      { event: { starterTasks: unknown[] } },
    ];
    expect(input.event.starterTasks).toHaveLength(1);
  });

  it('completes setup without a session for an empty selection', async () => {
    const result = await completeSetupWithStarterTasksCommand(buildAuth(), {
      launchBatchId: '11111111-1111-4111-8111-111111111111',
      selectedStarterTaskIds: [],
      productUpdatesEnabled: true,
    });

    expect(mockStartSetupFastSession).not.toHaveBeenCalled();
    expect(mockCompleteSetup).toHaveBeenCalledWith(expect.anything(), {
      productUpdatesEnabled: true,
    });
    expect(result).toEqual({
      sessionId: null,
      setupCompleted: true,
      completionError: null,
    });
  });

  it('reports a completion error and creates no session when setup completion fails', async () => {
    mockCompleteSetup.mockRejectedValueOnce(new Error('settings write failed'));

    const result = await completeSetupWithStarterTasksCommand(buildAuth(), {
      launchBatchId: '11111111-1111-4111-8111-111111111111',
      selectedStarterTaskIds: ['fix-test-flakes'],
    });

    expect(mockStartSetupFastSession).not.toHaveBeenCalled();
    expect(result).toEqual({
      sessionId: null,
      setupCompleted: false,
      completionError: 'settings write failed',
    });
  });
});
