import { describe, expect, it, vi } from 'vitest';

import { ACP_ENVELOPE_EVENT_TYPES } from '@roomote/types';
import type {
  AcpMessage,
  AcpPersistedEnvelope,
  AcpTurnCompletedEvent,
  TaskEvent,
} from '@roomote/types';

import { OpenCodeRuntimeEventEmitter } from './runtime-event-emitter';

function createEmitter() {
  const runtimeOutput = vi.fn<(event: AcpMessage) => void>();
  const runtimePersistedEnvelope =
    vi.fn<(envelope: AcpPersistedEnvelope) => void>();
  const runtimeTurnCompleted = vi.fn<(event: AcpTurnCompletedEvent) => void>();
  const taskEvent = vi.fn<(event: TaskEvent) => void>();

  return {
    emitter: new OpenCodeRuntimeEventEmitter({
      runtimeOutput,
      runtimePersistedEnvelope,
      runtimeTurnCompleted,
      taskEvent,
    }),
    runtimeOutput,
    runtimePersistedEnvelope,
  };
}

describe('OpenCodeRuntimeEventEmitter', () => {
  it('keeps live assistant thought chunks visible in the transcript', () => {
    const { emitter, runtimeOutput } = createEmitter();

    emitter.assistantThoughtChunk({
      sessionId: 'session-1',
      messageId: 'message-1',
      text: 'Thinking through the fix.',
    });

    const event = runtimeOutput.mock.calls[0]?.[0];

    expect(event).toMatchObject({
      eventType: ACP_ENVELOPE_EVENT_TYPES.AssistantThoughtChunk,
      text: 'Thinking through the fix.',
    });
    expect(event).not.toHaveProperty('visibleInTranscript');
  });

  it('persists the consolidated assistant thought without a live re-emit when reasoning already streamed', () => {
    const { emitter, runtimeOutput, runtimePersistedEnvelope } =
      createEmitter();

    emitter.assistantThought({
      sessionId: 'session-1',
      messageId: 'message-1',
      text: 'Thinking through the fix.',
      hadDelta: true,
    });

    expect(runtimeOutput).not.toHaveBeenCalled();
    expect(runtimePersistedEnvelope.mock.calls[0]?.[0]).toMatchObject({
      eventType: ACP_ENVELOPE_EVENT_TYPES.AssistantThought,
      payload: { text: 'Thinking through the fix.' },
    });
  });

  it('emits the consolidated assistant thought live and persisted when reasoning never streamed', () => {
    const { emitter, runtimeOutput, runtimePersistedEnvelope } =
      createEmitter();

    emitter.assistantThought({
      sessionId: 'session-1',
      messageId: 'message-1',
      text: 'Thinking through the fix.',
    });

    expect(runtimeOutput.mock.calls[0]?.[0]).toMatchObject({
      eventType: ACP_ENVELOPE_EVENT_TYPES.AssistantThought,
      text: 'Thinking through the fix.',
    });
    expect(runtimePersistedEnvelope.mock.calls[0]?.[0]).toMatchObject({
      eventType: ACP_ENVELOPE_EVENT_TYPES.AssistantThought,
      payload: { text: 'Thinking through the fix.' },
    });
  });

  it('persists goal provenance on the originating user prompt', () => {
    const { emitter, runtimeOutput, runtimePersistedEnvelope } =
      createEmitter();

    emitter.userPrompt({
      sessionId: 'session-1',
      text: 'Count to ten',
      goalContext: {
        objective: 'Count to ten',
        generation: 'goal-generation:1',
        status: 'active',
        maxContinuations: 5,
        continuationsUsed: 0,
        blockedReason: null,
        completedAt: null,
      },
    });

    expect(runtimeOutput.mock.calls[0]?.[0]).toMatchObject({
      payload: {
        goal: {
          objective: 'Count to ten',
          generation: 'goal-generation:1',
        },
      },
    });
    expect(runtimePersistedEnvelope.mock.calls[0]?.[0]).toMatchObject({
      payload: {
        goal: {
          objective: 'Count to ten',
          generation: 'goal-generation:1',
        },
      },
    });
  });

  it('stamps stable logical ids on paired live and persisted tool call events', () => {
    const { emitter, runtimeOutput, runtimePersistedEnvelope } =
      createEmitter();

    emitter.toolCall({
      sessionId: 'session-1',
      messageId: 'turn-1',
      toolCallId: 'tool-1',
      title: 'Run tests',
      status: 'in_progress',
      payload: {
        toolCallId: 'tool-1',
        title: 'Run tests',
        kind: 'execute',
      },
    });

    const logicalEventId = 'session-1:turn-1:tool-1:roomote_runtime.tool_call';
    const liveEvent = runtimeOutput.mock.calls[0]?.[0];
    const persistedEnvelope = runtimePersistedEnvelope.mock.calls[0]?.[0];

    expect(liveEvent).toMatchObject({
      logicalEventId,
      metadata: { logicalEventId },
      payload: { logicalEventId },
    });
    expect(persistedEnvelope).toMatchObject({
      logicalEventId,
      metadata: { logicalEventId },
      payload: { logicalEventId },
    });
  });

  it('emits and persists a task_cancelled marker with attribution', () => {
    const { emitter, runtimeOutput, runtimePersistedEnvelope } =
      createEmitter();

    emitter.taskCancelled({
      sessionId: 'session-1',
      cancelledByName: 'Daniel',
      source: 'web',
    });

    const liveEvent = runtimeOutput.mock.calls[0]?.[0];
    const persistedEnvelope = runtimePersistedEnvelope.mock.calls[0]?.[0];

    expect(liveEvent).toMatchObject({
      eventType: ACP_ENVELOPE_EVENT_TYPES.TaskCancelled,
      kind: 'task_cancelled',
      role: 'system',
      text: 'Stopped by Daniel',
      payload: {
        sessionId: 'session-1',
        cancelledByName: 'Daniel',
        source: 'web',
      },
    });
    expect(persistedEnvelope).toMatchObject({
      eventType: ACP_ENVELOPE_EVENT_TYPES.TaskCancelled,
      role: 'system',
      payload: {
        sessionId: 'session-1',
        cancelledByName: 'Daniel',
        source: 'web',
      },
    });
    // Live and persisted share one logical id so they reconcile as the same
    // transcript item.
    expect(liveEvent?.logicalEventId).toBeDefined();
    expect(liveEvent?.logicalEventId).toBe(persistedEnvelope?.logicalEventId);
  });

  it('keeps repeated task_cancelled markers logically distinct', () => {
    const { emitter, runtimePersistedEnvelope } = createEmitter();

    emitter.taskCancelled({ sessionId: 'session-1' });
    emitter.taskCancelled({ sessionId: 'session-1' });

    const [first, second] = runtimePersistedEnvelope.mock.calls.map(
      (call) => call[0],
    );

    expect(first?.payload).not.toHaveProperty('cancelledByName');
    expect(first?.logicalEventId).toBeDefined();
    expect(second?.logicalEventId).toBeDefined();
    expect(first?.logicalEventId).not.toBe(second?.logicalEventId);
  });
});
