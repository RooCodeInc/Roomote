import { ACP_ENVELOPE_EVENT_TYPES } from '@roomote/types';

import {
  acpQueuedMessagesUpdate,
  acpRequestUserInput,
  acpRequestUserInputResponse,
  acpUserPrompt,
} from './use-sandbox-store-test-kit';
import { createSandboxLiveEventApplier } from '../services/sandbox-live-event-application';

function createTaskStatus(
  phase: 'running' | 'waiting_for_user_input',
  options?: { sleepRemainingMs?: number | null },
) {
  return {
    phase,
    taskStateEvent: null,
    sessionId: 'session-1',
    isConnected: true,
    sleepRemainingMs: options?.sleepRemainingMs ?? null,
    lastErrorMessage: undefined,
  } as const;
}

function createHarness() {
  const state = {
    _handleAcpEvent: vi.fn(() => null),
    _setQueuedMessages: vi.fn(),
    _setTaskStatus: vi.fn(),
    _syncPendingEnvVarRequest: vi.fn(),
    _syncPendingUserInputRequests: vi.fn(),
  };

  return {
    state,
    store: {
      getState: () => state,
    },
    publishTaskStatus: vi.fn(),
    invalidateMessageEnvelopes: vi.fn(),
    invalidateSandboxSession: vi.fn(),
    replaceOptimisticPrompt: vi.fn(),
    scheduleTitleRefresh: vi.fn(),
  };
}

describe('sandbox live event application', () => {
  it('does not let a stale runtime snapshot overwrite newer live task state', () => {
    const harness = createHarness();
    const applier = createSandboxLiveEventApplier({
      store: harness.store,
      publishTaskStatus: harness.publishTaskStatus,
      invalidateSandboxSession: harness.invalidateSandboxSession,
      invalidateMessageEnvelopes: harness.invalidateMessageEnvelopes,
      replaceOptimisticPrompt: harness.replaceOptimisticPrompt,
      scheduleTitleRefresh: harness.scheduleTitleRefresh,
    });
    const syncPoint = applier.captureSyncPoint();

    applier.applyEvent({
      type: 'runtimeOutput',
      event: acpQueuedMessagesUpdate(
        [
          {
            id: 'runtime-queued-live',
            text: 'Use the live queue state',
            timestamp: 9,
          },
        ],
        { sequence: 9, ts: 9 },
      ),
    });
    applier.applyEvent({
      type: 'runtimeOutput',
      event: acpRequestUserInput({
        ts: 10,
        requestId: 'rui:session-1:turn-1:call-1',
        questions: [
          {
            id: 'color',
            header: 'Color',
            question: 'Pick a color',
            isOther: false,
            isSecret: false,
            options: [{ label: 'Blue', description: 'Use blue.' }],
          },
        ],
      }),
    });
    applier.applyEvent({
      type: 'runtimeOutput',
      event: acpRequestUserInputResponse({
        ts: 11,
        requestId: 'rui:session-1:turn-1:call-1',
        answers: {
          color: {
            answers: ['Blue'],
          },
        },
      }),
    });
    applier.applyEvent({
      type: 'taskStatus',
      status: createTaskStatus('running', { sleepRemainingMs: 15_000 }),
    });

    applier.applyRuntimeState(
      {
        status: createTaskStatus('waiting_for_user_input', {
          sleepRemainingMs: 30_000,
        }),
        pendingUserInputRequests: [
          {
            requestId: 'rui:session-1:turn-1:call-1',
            sessionId: 'session-1',
            turnId: 'turn-1',
            callId: 'call-1',
            status: 'pending',
            ts: 9,
            questions: [
              {
                id: 'color',
                header: 'Color',
                question: 'Pick a color',
                isOther: false,
                isSecret: false,
                options: [{ label: 'Blue', description: 'Use blue.' }],
              },
            ],
          },
        ],
        pendingEnvVarRequest: null,
        queuedMessages: [
          {
            id: 'runtime-queued-stale',
            text: 'Stale runtime queue state',
            timestamp: 8,
          },
        ],
      },
      syncPoint,
    );

    expect(harness.state._setTaskStatus).toHaveBeenCalledTimes(1);
    expect(harness.state._setTaskStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        phase: 'running',
      }),
    );
    expect(harness.publishTaskStatus).toHaveBeenCalledTimes(1);
    expect(harness.publishTaskStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        phase: 'running',
      }),
    );
    expect(harness.state._syncPendingUserInputRequests).not.toHaveBeenCalled();
    expect(harness.state._setQueuedMessages).not.toHaveBeenCalled();
    expect(harness.invalidateMessageEnvelopes).toHaveBeenCalledTimes(1);
  });

  it('handles user prompts through the prompt-replacement and refresh callbacks', () => {
    const harness = createHarness();
    const applier = createSandboxLiveEventApplier({
      store: harness.store,
      publishTaskStatus: harness.publishTaskStatus,
      invalidateSandboxSession: harness.invalidateSandboxSession,
      invalidateMessageEnvelopes: harness.invalidateMessageEnvelopes,
      replaceOptimisticPrompt: harness.replaceOptimisticPrompt,
      scheduleTitleRefresh: harness.scheduleTitleRefresh,
    });
    const promptEvent = acpUserPrompt('Ship it', {
      clientMessageId: 'client-message-1',
      ts: 42,
    });

    applier.applyEvent({
      type: 'runtimeOutput',
      event: promptEvent,
    });

    expect(promptEvent.eventType).toBe(ACP_ENVELOPE_EVENT_TYPES.UserPrompt);
    expect(harness.replaceOptimisticPrompt).toHaveBeenCalledWith(promptEvent);
    expect(harness.scheduleTitleRefresh).toHaveBeenCalledTimes(1);
  });
});
