import { RunStatus, TaskPayloadKind } from '@roomote/types';

import type { CloudJobDetail } from '@/lib/server';
import { getCloudJobVisiblePrompt } from '@/lib';

import { restoreSnapshotResumeVisiblePromptFields } from '../snapshot-visible-prompt';

import {
  getSessionState,
  isWaitingForFirstHarnessMessage,
  shouldPollForFirstHarnessMessage,
} from './session-state';

function createCloudJobDetail(
  overrides: Partial<CloudJobDetail> = {},
): CloudJobDetail {
  return {
    id: 1,
    taskId: 'task-1',
    kind: 'fresh',
    sourceRunId: null,
    actingUserId: null,
    payloadKind: TaskPayloadKind.StandardTask,
    payload: { repo: 'owner/repo', description: 'Test task' },
    status: RunStatus.Pending,
    taskPhase: null,
    error: null,
    prompt: null,
    result: null,
    machineId: null,
    machineDomain: null,
    machineDomains: null,
    primaryPortName: null,
    initialPaths: null,
    proxyPorts: null,
    vendor: null,
    sandboxCmdId: null,
    sandboxServerUrl: null,
    createdAt: new Date(),
    startedAt: null,
    completedAt: null,
    canceledAt: null,
    sourceSnapshotId: null,
    snapshotId: null,
    snapshotRequestedAt: null,
    snapshotCreatedAt: null,
    snapshotFailedAt: null,
    sleepAt: null,
    sleepRequestedAt: null,
    refetchInterval: undefined,
    authBypassValue: null,
    authBypassHeaderName: null,
    harness: 'opencode-server',
    user: null,
    actingUser: null,
    ...overrides,
  } as CloudJobDetail;
}

describe('getSessionState', () => {
  it('treats canceled jobs with an early boot error as boot-failed', () => {
    const cloudJob = createCloudJobDetail({
      status: RunStatus.Canceled,
      error:
        'OpenAI admin request failed (401): {"error":{"message":"Incorrect API key provided.","code":"invalid_api_key"}}',
    });

    expect(
      getSessionState(cloudJob, {
        hasMessages: false,
        hasHarnessMessages: false,
      }),
    ).toBe('boot-failed');
  });

  it('keeps ordinary canceled jobs in historical mode', () => {
    const cloudJob = createCloudJobDetail({
      status: RunStatus.Canceled,
      error: null,
    });

    expect(
      getSessionState(cloudJob, {
        hasMessages: false,
        hasHarnessMessages: false,
      }),
    ).toBe('historical');
  });

  it('treats canceled jobs with result.error as boot-failed before any messages exist', () => {
    const cloudJob = createCloudJobDetail({
      status: RunStatus.Canceled,
      error: null,
      result: {
        error:
          'Required environment command Install dependencies failed for owner/repo: Command failed with exit code 1',
      },
    });

    expect(
      getSessionState(cloudJob, {
        hasMessages: false,
        hasHarnessMessages: false,
      }),
    ).toBe('boot-failed');
  });

  it('keeps running jobs in startup until the harness emits a first message', () => {
    const cloudJob = createCloudJobDetail({
      status: RunStatus.Running,
    });

    expect(
      getSessionState(cloudJob, {
        hasMessages: false,
        hasHarnessMessages: false,
      }),
    ).toBe('booting');

    expect(
      getSessionState(cloudJob, {
        hasMessages: false,
        hasHarnessMessages: true,
      }),
    ).toBe('interactive');
  });

  it('keeps snapshot resumes in resuming mode until a first harness message', () => {
    const cloudJob = createCloudJobDetail({
      status: RunStatus.Running,
      payloadKind: TaskPayloadKind.SnapshotResume,
    });

    expect(
      getSessionState(cloudJob, {
        hasMessages: false,
        hasHarnessMessages: false,
      }),
    ).toBe('resuming');

    expect(
      getSessionState(cloudJob, {
        hasMessages: false,
        hasHarnessMessages: true,
      }),
    ).toBe('interactive');
  });

  it('falls through to interactive after 7s without harness messages', () => {
    const startedAt = new Date('2025-01-01T00:00:00Z');
    const cloudJob = createCloudJobDetail({
      status: RunStatus.Running,
      startedAt,
    });

    // Before the timeout: still booting
    expect(
      getSessionState(cloudJob, {
        hasMessages: false,
        hasHarnessMessages: false,
        now: startedAt.getTime() + 6_999,
      }),
    ).toBe('booting');

    // At the timeout boundary: interactive
    expect(
      getSessionState(cloudJob, {
        hasMessages: false,
        hasHarnessMessages: false,
        now: startedAt.getTime() + 7_000,
      }),
    ).toBe('interactive');
  });

  it('falls through to interactive after 7s for snapshot resumes without harness messages', () => {
    const startedAt = new Date('2025-01-01T00:00:00Z');
    const cloudJob = createCloudJobDetail({
      status: RunStatus.Running,
      payloadKind: TaskPayloadKind.SnapshotResume,
      startedAt,
    });

    // Before the timeout: still resuming
    expect(
      getSessionState(cloudJob, {
        hasMessages: false,
        hasHarnessMessages: false,
        now: startedAt.getTime() + 6_999,
      }),
    ).toBe('resuming');

    // At the timeout boundary: interactive
    expect(
      getSessionState(cloudJob, {
        hasMessages: false,
        hasHarnessMessages: false,
        now: startedAt.getTime() + 7_000,
      }),
    ).toBe('interactive');
  });
});

describe('isWaitingForFirstHarnessMessage', () => {
  it('returns true for booting or resuming sessions without harness output', () => {
    expect(
      isWaitingForFirstHarnessMessage({
        sessionState: 'booting',
        hasHarnessMessages: false,
      }),
    ).toBe(true);

    expect(
      isWaitingForFirstHarnessMessage({
        sessionState: 'resuming',
        hasHarnessMessages: false,
      }),
    ).toBe(true);
  });

  it('returns false once session state is interactive even if no harness message exists', () => {
    const startedAt = new Date('2025-01-01T00:00:00Z');
    const cloudJob = createCloudJobDetail({
      status: RunStatus.Running,
      startedAt,
    });

    const timedOutSessionState = getSessionState(cloudJob, {
      hasMessages: false,
      hasHarnessMessages: false,
      now: startedAt.getTime() + 7_000,
    });

    expect(
      isWaitingForFirstHarnessMessage({
        sessionState: timedOutSessionState,
        hasHarnessMessages: false,
      }),
    ).toBe(false);
  });

  it('returns false when a harness message already exists', () => {
    expect(
      isWaitingForFirstHarnessMessage({
        sessionState: 'booting',
        hasHarnessMessages: true,
      }),
    ).toBe(false);
  });
});

describe('shouldPollForFirstHarnessMessage', () => {
  it('keeps polling after startup timeout when a prompt-bearing task has no harness output', () => {
    expect(
      shouldPollForFirstHarnessMessage({
        sessionState: 'interactive',
        cloudJobStatus: RunStatus.Running,
        hasHarnessMessages: false,
        hasInitialPrompt: true,
      }),
    ).toBe(true);
  });

  it('does not keep polling after startup timeout for prompt-less interactive sessions', () => {
    expect(
      shouldPollForFirstHarnessMessage({
        sessionState: 'interactive',
        cloudJobStatus: RunStatus.Running,
        hasHarnessMessages: false,
        hasInitialPrompt: false,
      }),
    ).toBe(false);
  });

  it('does not poll once harness output exists or the task has exited', () => {
    expect(
      shouldPollForFirstHarnessMessage({
        sessionState: 'interactive',
        cloudJobStatus: RunStatus.Running,
        hasHarnessMessages: true,
        hasInitialPrompt: true,
      }),
    ).toBe(false);

    expect(
      shouldPollForFirstHarnessMessage({
        sessionState: 'historical',
        cloudJobStatus: RunStatus.Completed,
        hasHarnessMessages: false,
        hasInitialPrompt: true,
      }),
    ).toBe(false);
  });
});

describe('restoreSnapshotResumeVisiblePromptFields', () => {
  it('restores commentBody for GitHub follow-up resumes', () => {
    const payload: Record<string, unknown> = {
      repo: 'Roomote/example-app',
      sourceCloudJobId: 123,
      sourceSnapshotId: 'snapshot-123',
    };

    restoreSnapshotResumeVisiblePromptFields(payload, {
      commentBody: 'Fix this specific issue:\n\nWake-up should keep this text.',
    });

    expect(payload.commentBody).toBe(
      'Fix this specific issue:\n\nWake-up should keep this text.',
    );
  });

  it('preserves existing prompt fields and restores images when missing', () => {
    const payload: Record<string, unknown> = {
      text: 'Existing prompt',
    };

    restoreSnapshotResumeVisiblePromptFields(payload, {
      text: 'Source prompt',
      images: ['https://example.com/one.png'],
    });

    expect(payload.text).toBe('Existing prompt');
    expect(payload.images).toEqual(['https://example.com/one.png']);
  });

  it('restores visibleInTranscript when missing from snapshot resumes', () => {
    const payload: Record<string, unknown> = {
      text: 'Existing prompt',
    };

    restoreSnapshotResumeVisiblePromptFields(payload, {
      text: 'Source prompt',
      visibleInTranscript: false,
    });

    expect(payload.visibleInTranscript).toBe(false);
  });

  it('restores reasoningEffort when missing from snapshot resumes', () => {
    const payload: Record<string, unknown> = {
      text: 'Existing prompt',
    };

    restoreSnapshotResumeVisiblePromptFields(payload, {
      reasoningEffort: 'medium',
    });

    expect(payload.reasoningEffort).toBe('medium');
  });
});

describe('getCloudJobVisiblePrompt', () => {
  it('respects explicit payload transcript visibility flags', () => {
    const cloudJob = createCloudJobDetail({
      payload: {
        repo: 'owner/repo',
        description: '$environment-setup',
        visibleInTranscript: false,
      },
    });

    expect(getCloudJobVisiblePrompt(cloudJob)).toMatchObject({
      text: '$environment-setup',
      visibleInTranscript: false,
    });
  });

  it('keeps legacy hidden bootstrap prompts out of the session transcript', () => {
    const cloudJob = createCloudJobDetail({
      payload: {
        repo: 'owner/repo',
        description: '$environment-setup\n<request>Set up the app</request>',
      },
    });

    expect(getCloudJobVisiblePrompt(cloudJob)).toMatchObject({
      visibleInTranscript: false,
    });
  });
});
