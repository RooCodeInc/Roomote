import { TaskEventName, type TaskEvent } from '@roomote/types';

import type { OpenCodeServerClient } from '../opencode-server/client';
import { OpenCodeServerHarness } from '../opencode-server/harness';
import { TaskCommandName } from '../../harness';
import type {
  OpenCodeGlobalEvent,
  OpenCodeSession,
  OpenCodeSessionMessage,
} from '../opencode-server/types';

const TEST_OPENCODE_MODEL = 'test-provider/main-model';
// Far beyond any plausible run length: subagent runs are not time-bounded, so
// nothing may abort even at this horizon.
const SIX_HOURS_MS = 6 * 60 * 60_000;

class FakeOpenCodeServerClient {
  private eventHandler:
    | ((event: OpenCodeGlobalEvent) => void | Promise<void>)
    | undefined;

  health = vi.fn(async () => ({ healthy: true as const, version: 'test' }));
  createSession = vi.fn(async () => ({ id: 'ses_1', title: 'test' }));
  promptAsync = vi.fn(async (_options: unknown) => undefined);
  messages = vi.fn(async () => [] as OpenCodeSessionMessage[]);
  message = vi.fn<() => Promise<OpenCodeSessionMessage>>();
  abort = vi.fn(async (_options: { sessionId: string }) => true);
  children = vi.fn(
    async (_options: { sessionId: string }) => [] as OpenCodeSession[],
  );
  get sessionCreateTimeoutMsValue(): number {
    return 90_000;
  }
  streamEvents = vi.fn(
    async (options: {
      signal: AbortSignal;
      onEvent: (event: OpenCodeGlobalEvent) => void | Promise<void>;
    }) => {
      this.eventHandler = options.onEvent;

      await new Promise<void>((resolve) => {
        if (options.signal.aborted) {
          resolve();
          return;
        }

        options.signal.addEventListener('abort', () => resolve(), {
          once: true,
        });
      });
    },
  );

  async emit(event: OpenCodeGlobalEvent): Promise<void> {
    if (!this.eventHandler) {
      throw new Error('OpenCode event stream is not subscribed.');
    }

    await this.eventHandler(event);
  }
}

function createLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

const SETTLEMENT_GRACE_MS = 10_000;

function createHarness(client = new FakeOpenCodeServerClient()) {
  const logger = createLogger();
  const harness = new OpenCodeServerHarness({
    client: client as unknown as OpenCodeServerClient,
    workspacePath: '/tmp/workspace',
    logger,
    model: TEST_OPENCODE_MODEL,
    eventStreamReadyTimeoutMs: 100,
    subagentSettlementGraceMs: SETTLEMENT_GRACE_MS,
  });

  return { client, harness, logger };
}

async function connectHarness(
  harness: OpenCodeServerHarness,
  client: FakeOpenCodeServerClient,
): Promise<void> {
  const connectPromise = harness.connect();

  await vi.waitFor(() => {
    expect(client.streamEvents).toHaveBeenCalledTimes(1);
  });
  await client.emit({ type: 'server.connected' });
  await connectPromise;
}

// Mirrors the real OpenCode 1.17.18 shape observed live: subagent spawns
// arrive as `task` tool parts on the parent session; state.input carries
// subagent_type and state.metadata.sessionId points at the child session once
// it exists.
function createTaskToolPart(options: {
  status?: string;
  metadata?: Record<string, unknown>;
  output?: string;
  input?: Record<string, unknown>;
  callId?: string;
  messageId?: string;
}) {
  const callId = options.callId ?? 'call_task_1';

  return {
    id: `prt_${callId}`,
    sessionID: 'ses_1',
    messageID: options.messageId ?? 'msg_1',
    type: 'tool',
    tool: 'task',
    callID: callId,
    state: {
      status: options.status ?? 'running',
      input: {
        description: 'Capture home page screenshot proof',
        prompt: 'Proof brief: capture the home page.',
        subagent_type: 'proof-runner',
        ...(options.input ?? {}),
      },
      title: 'Capture home page screenshot proof',
      ...(options.metadata ? { metadata: options.metadata } : {}),
      ...(options.output ? { output: options.output } : {}),
    },
  };
}

function createSubtaskPart(overrides: Record<string, unknown> = {}) {
  return {
    id: 'subtask_part_1',
    sessionID: 'ses_1',
    messageID: 'msg_1',
    type: 'subtask',
    prompt: 'Run the proof suite.',
    description: 'Proof run',
    agent: 'proof-runner',
    ...overrides,
  };
}

function createChildToolPart(options: {
  callId: string;
  tool?: string;
  command?: string;
  status?: string;
}) {
  return {
    id: `prt_child_${options.callId}`,
    sessionID: 'ses_child_1',
    messageID: 'msg_child_1',
    type: 'tool',
    tool: options.tool ?? 'bash',
    callID: options.callId,
    state: {
      status: options.status ?? 'running',
      input: options.command ? { command: options.command } : {},
    },
  };
}

function createChildTextPart(text: string, role?: 'assistant') {
  return {
    id: 'prt_child_text_1',
    sessionID: 'ses_child_1',
    messageID: 'msg_child_1',
    type: 'text',
    text,
    ...(role ? { role } : {}),
  };
}

async function armSpawn(
  client: FakeOpenCodeServerClient,
  harness: OpenCodeServerHarness,
) {
  // Establish the parent session so child-session events hit the
  // sessionId guard instead of being processed as parent parts.
  harness.sendCommand({
    commandName: TaskCommandName.StartNewTask,
    data: { text: 'Do work.', visibleInTranscript: true },
  });
  await vi.waitFor(() => {
    expect(client.createSession).toHaveBeenCalled();
  });
  await client.emit({
    type: 'message.part.updated',
    properties: {
      part: createTaskToolPart({
        status: 'running',
        metadata: { sessionId: 'ses_child_1' },
      }),
    },
  });
}

function subagentActivityEvents(outputs: Array<Record<string, unknown>>) {
  return outputs.filter(
    (event) =>
      (event.payload as Record<string, unknown>)?.progressKind ===
      'subagent_activity',
  );
}

describe('OpenCode subagent run tracking', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('never aborts a foreground child, no matter how long it runs', async () => {
    const { client, harness } = createHarness();

    try {
      await connectHarness(harness, client);
      vi.useFakeTimers();

      await client.emit({
        type: 'message.part.updated',
        properties: {
          part: createTaskToolPart({
            status: 'running',
            metadata: { sessionId: 'ses_child_1', parentSessionId: 'ses_1' },
          }),
        },
      });

      await vi.advanceTimersByTimeAsync(SIX_HOURS_MS);

      expect(client.abort).not.toHaveBeenCalled();
      expect(client.children).not.toHaveBeenCalled();
    } finally {
      harness.dispose();
    }
  });

  it('never aborts a spawn whose child session id is unknown', async () => {
    const { client, harness } = createHarness();

    try {
      await connectHarness(harness, client);
      vi.useFakeTimers();

      await client.emit({
        type: 'message.part.updated',
        properties: { part: createTaskToolPart({ status: 'pending' }) },
      });

      await vi.advanceTimersByTimeAsync(SIX_HOURS_MS);

      expect(client.abort).not.toHaveBeenCalled();
      expect(client.children).not.toHaveBeenCalled();
    } finally {
      harness.dispose();
    }
  });

  it('never aborts a child that goes silent between tools', async () => {
    const { client, harness } = createHarness();

    try {
      await connectHarness(harness, client);
      vi.useFakeTimers();
      await armSpawn(client, harness);

      await client.emit({
        type: 'message.part.updated',
        properties: {
          part: createChildToolPart({ callId: 'c1', command: 'pnpm build' }),
        },
      });
      await client.emit({
        type: 'message.part.updated',
        properties: {
          part: createChildToolPart({ callId: 'c1', status: 'completed' }),
        },
      });

      // Silence after the completed tool: a reasoning model may think for a
      // long stretch without emitting any events. Nothing may kill it.
      await vi.advanceTimersByTimeAsync(SIX_HOURS_MS);

      expect(client.abort).not.toHaveBeenCalled();
      expect(client.children).not.toHaveBeenCalled();
    } finally {
      await harness.dispose();
    }
  });

  it('never aborts subtask-part spawns', async () => {
    const { client, harness } = createHarness();

    try {
      await connectHarness(harness, client);
      vi.useFakeTimers();

      await client.emit({
        type: 'message.part.updated',
        properties: { part: createSubtaskPart() },
      });

      await vi.advanceTimersByTimeAsync(SIX_HOURS_MS);

      expect(client.abort).not.toHaveBeenCalled();
      expect(client.children).not.toHaveBeenCalled();
    } finally {
      harness.dispose();
    }
  });

  it('stops tracking when the task tool part reaches a terminal status', async () => {
    const { client, harness } = createHarness();
    const outputs: Array<Record<string, unknown>> = [];
    harness.on('runtimeOutput', (event) => {
      outputs.push(event as unknown as Record<string, unknown>);
    });

    try {
      await connectHarness(harness, client);
      await armSpawn(client, harness);
      await client.emit({
        type: 'message.part.updated',
        properties: {
          part: createTaskToolPart({
            status: 'completed',
            metadata: { sessionId: 'ses_child_1' },
            output: '<task_result>done</task_result>',
          }),
        },
      });

      const settledCount = subagentActivityEvents(outputs).length;

      // Child events after settlement no longer fold into the spawn row.
      await client.emit({
        type: 'message.part.updated',
        properties: {
          part: createChildToolPart({ callId: 'c_late', command: 'ls' }),
        },
      });

      expect(subagentActivityEvents(outputs)).toHaveLength(settledCount);
      expect(client.abort).not.toHaveBeenCalled();
    } finally {
      await harness.dispose();
    }
  });

  it('never finishes the parent turn from a child session.error', async () => {
    const { client, harness } = createHarness();
    const taskEvents: TaskEvent[] = [];
    harness.subscribe((event) => taskEvents.push(event));

    try {
      await connectHarness(harness, client);
      await armSpawn(client, harness);

      await client.emit({
        type: 'session.error',
        properties: {
          sessionID: 'ses_child_1',
          error: { name: 'MessageAbortedError' },
        },
      });

      expect(
        taskEvents.some(
          (event) =>
            event.eventName === TaskEventName.TaskCompleted ||
            event.eventName === TaskEventName.TaskAborted,
        ),
      ).toBe(false);
      expect(client.abort).not.toHaveBeenCalled();
    } finally {
      await harness.dispose();
    }
  });

  it('ends background tracking on child session idle without finishing the parent turn', async () => {
    const { client, harness } = createHarness();
    const taskEvents: TaskEvent[] = [];
    harness.subscribe((event) => taskEvents.push(event));

    try {
      await connectHarness(harness, client);

      harness.sendCommand({
        commandName: TaskCommandName.StartNewTask,
        data: { text: 'Do work.', visibleInTranscript: true },
      });
      await vi.waitFor(() => {
        expect(client.createSession).toHaveBeenCalled();
      });

      // Keep the parent turn in flight so a wrongly routed child idle would
      // observably complete the turn.
      await client.emit({
        type: 'session.status',
        properties: { sessionID: 'ses_1', status: { type: 'busy' } },
      });
      await client.emit({
        type: 'message.part.updated',
        properties: {
          part: createTaskToolPart({
            status: 'completed',
            input: { background: true },
            metadata: { sessionId: 'ses_child_1' },
            output: '<task id="job_1" state="running" />',
          }),
        },
      });

      // The child session going idle is the background run's completion
      // signal: it ends tracking and must not finish the parent turn.
      await client.emit({
        type: 'session.idle',
        properties: { sessionID: 'ses_child_1' },
      });

      expect(
        taskEvents.some(
          (event) => event.eventName === TaskEventName.TaskCompleted,
        ),
      ).toBe(false);

      // The parent session's own idle still completes the turn afterwards.
      await client.emit({
        type: 'session.idle',
        properties: { sessionID: 'ses_1' },
      });
      expect(
        taskEvents.some(
          (event) => event.eventName === TaskEventName.TaskCompleted,
        ),
      ).toBe(true);
      expect(client.abort).not.toHaveBeenCalled();
    } finally {
      harness.dispose();
    }
  });

  it('keeps the background tracker across parent turn finish', async () => {
    const { client, harness } = createHarness();
    const outputs: Array<Record<string, unknown>> = [];
    harness.on('runtimeOutput', (event) => {
      outputs.push(event as unknown as Record<string, unknown>);
    });

    try {
      await connectHarness(harness, client);

      harness.sendCommand({
        commandName: TaskCommandName.StartNewTask,
        data: { text: 'Do work.', visibleInTranscript: true },
      });
      await vi.waitFor(() => {
        expect(client.createSession).toHaveBeenCalled();
      });

      await client.emit({
        type: 'message.part.updated',
        properties: {
          part: createTaskToolPart({
            status: 'completed',
            input: { background: true },
            metadata: { sessionId: 'ses_child_1' },
            output: '<task id="job_1" state="running" />',
          }),
        },
      });

      // The parent turn finishes right after launching the background run —
      // the canonical non-blocking delivery shape.
      await client.emit({
        type: 'session.idle',
        properties: { sessionID: 'ses_1' },
      });

      // The background child keeps working: its events still fold into the
      // spawn row after the parent turn finished.
      await client.emit({
        type: 'message.part.updated',
        properties: {
          part: createChildToolPart({
            callId: 'c_bg',
            command: 'agent-browser screenshot',
          }),
        },
      });

      expect(subagentActivityEvents(outputs).length).toBeGreaterThan(0);
      expect(client.abort).not.toHaveBeenCalled();
    } finally {
      harness.dispose();
    }
  });

  it('clears foreground trackers when the parent turn finishes', async () => {
    const { client, harness } = createHarness();
    const outputs: Array<Record<string, unknown>> = [];
    harness.on('runtimeOutput', (event) => {
      outputs.push(event as unknown as Record<string, unknown>);
    });

    try {
      await connectHarness(harness, client);
      await armSpawn(client, harness);

      await client.emit({
        type: 'session.idle',
        properties: { sessionID: 'ses_1' },
      });

      const settledCount = subagentActivityEvents(outputs).length;

      // Foreground spawn tracking ended with the turn: late child events are
      // inert.
      await client.emit({
        type: 'message.part.updated',
        properties: {
          part: createChildToolPart({ callId: 'c_late', command: 'ls' }),
        },
      });
      await client.emit({
        type: 'session.idle',
        properties: { sessionID: 'ses_child_1' },
      });

      expect(subagentActivityEvents(outputs)).toHaveLength(settledCount);
      expect(client.abort).not.toHaveBeenCalled();
    } finally {
      harness.dispose();
    }
  });
});

describe('OpenCode subagent settlement recovery', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('aborts a finished child whose task tool call never settles', async () => {
    const { client, harness, logger } = createHarness();
    const taskEvents: TaskEvent[] = [];
    harness.subscribe((event) => taskEvents.push(event));

    try {
      await connectHarness(harness, client);
      vi.useFakeTimers();
      await armSpawn(client, harness);

      // The child session finishes, but no terminal task tool part ever
      // arrives: the spawn leaked inside OpenCode.
      await client.emit({
        type: 'session.idle',
        properties: { sessionID: 'ses_child_1' },
      });

      await vi.advanceTimersByTimeAsync(SETTLEMENT_GRACE_MS - 1);
      expect(client.abort).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);

      expect(client.abort).toHaveBeenCalledTimes(1);
      expect(client.abort).toHaveBeenCalledWith(
        expect.objectContaining({ sessionId: 'ses_child_1' }),
      );
      expect(client.children).not.toHaveBeenCalled();
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('did not settle'),
      );
      // Recovery acts on the child only; the parent turn is untouched.
      expect(
        taskEvents.some(
          (event) =>
            event.eventName === TaskEventName.TaskCompleted ||
            event.eventName === TaskEventName.TaskAborted,
        ),
      ).toBe(false);
    } finally {
      harness.dispose();
    }
  });

  it('never aborts a child whose latest assistant message is still in flight', async () => {
    const { client, harness, logger } = createHarness();

    try {
      await connectHarness(harness, client);
      vi.useFakeTimers();
      await armSpawn(client, harness);

      // The child looks terminal, but its persisted state says it is still
      // mid-message — a silent revival or a lookup we cannot trust. Recovery
      // must keep waiting instead of killing possibly-live work.
      client.messages.mockResolvedValue([
        {
          info: {
            id: 'msg_child_live',
            sessionID: 'ses_child_1',
            role: 'assistant',
            time: { created: 1 },
          },
          parts: [],
        },
      ] as unknown as OpenCodeSessionMessage[]);

      await client.emit({
        type: 'session.idle',
        properties: { sessionID: 'ses_child_1' },
      });

      await vi.advanceTimersByTimeAsync(SETTLEMENT_GRACE_MS * 3);

      expect(client.abort).not.toHaveBeenCalled();
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('not aborting'),
      );

      // Once the child's work is genuinely finished, the next re-check
      // recovers the still-unsettled spawn.
      client.messages.mockResolvedValue([
        {
          info: {
            id: 'msg_child_live',
            sessionID: 'ses_child_1',
            role: 'assistant',
            time: { created: 1, completed: 2 },
          },
          parts: [],
        },
      ] as unknown as OpenCodeSessionMessage[]);

      await vi.advanceTimersByTimeAsync(SETTLEMENT_GRACE_MS);

      expect(client.abort).toHaveBeenCalledTimes(1);
      expect(client.abort).toHaveBeenCalledWith(
        expect.objectContaining({ sessionId: 'ses_child_1' }),
      );
    } finally {
      harness.dispose();
    }
  });

  it('never aborts when the pre-abort verification cannot reach the child', async () => {
    const { client, harness, logger } = createHarness();

    try {
      await connectHarness(harness, client);
      vi.useFakeTimers();
      await armSpawn(client, harness);

      client.messages.mockRejectedValue(new Error('connection reset'));

      await client.emit({
        type: 'session.idle',
        properties: { sessionID: 'ses_child_1' },
      });

      await vi.advanceTimersByTimeAsync(SETTLEMENT_GRACE_MS * 3);

      expect(client.abort).not.toHaveBeenCalled();
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('Could not verify'),
      );
    } finally {
      harness.dispose();
    }
  });

  it('does not recover when the task tool part settles within the grace', async () => {
    const { client, harness } = createHarness();

    try {
      await connectHarness(harness, client);
      vi.useFakeTimers();
      await armSpawn(client, harness);

      await client.emit({
        type: 'session.idle',
        properties: { sessionID: 'ses_child_1' },
      });
      await client.emit({
        type: 'message.part.updated',
        properties: {
          part: createTaskToolPart({
            status: 'completed',
            metadata: { sessionId: 'ses_child_1' },
            output: '<task_result>done</task_result>',
          }),
        },
      });

      await vi.advanceTimersByTimeAsync(SETTLEMENT_GRACE_MS * 3);

      expect(client.abort).not.toHaveBeenCalled();
    } finally {
      harness.dispose();
    }
  });

  it('cancels pending recovery when the child emits again', async () => {
    const { client, harness } = createHarness();

    try {
      await connectHarness(harness, client);
      vi.useFakeTimers();
      await armSpawn(client, harness);

      await client.emit({
        type: 'session.idle',
        properties: { sessionID: 'ses_child_1' },
      });

      // A provider retry picks the child session back up before the grace
      // expires: the child is alive, so nothing may abort it.
      await vi.advanceTimersByTimeAsync(SETTLEMENT_GRACE_MS - 1);
      await client.emit({
        type: 'message.part.updated',
        properties: {
          part: createChildToolPart({ callId: 'c_retry', command: 'ls' }),
        },
      });

      await vi.advanceTimersByTimeAsync(SETTLEMENT_GRACE_MS * 3);

      expect(client.abort).not.toHaveBeenCalled();
    } finally {
      harness.dispose();
    }
  });

  it('arms the same recovery for a child session error', async () => {
    const { client, harness } = createHarness();

    try {
      await connectHarness(harness, client);
      vi.useFakeTimers();
      await armSpawn(client, harness);

      await client.emit({
        type: 'session.error',
        properties: {
          sessionID: 'ses_child_1',
          error: { name: 'ProviderError' },
        },
      });

      await vi.advanceTimersByTimeAsync(SETTLEMENT_GRACE_MS);

      expect(client.abort).toHaveBeenCalledTimes(1);
      expect(client.abort).toHaveBeenCalledWith(
        expect.objectContaining({ sessionId: 'ses_child_1' }),
      );
    } finally {
      harness.dispose();
    }
  });

  it('does not arm recovery for background launches', async () => {
    const { client, harness } = createHarness();

    try {
      await connectHarness(harness, client);

      harness.sendCommand({
        commandName: TaskCommandName.StartNewTask,
        data: { text: 'Do work.', visibleInTranscript: true },
      });
      await vi.waitFor(() => {
        expect(client.createSession).toHaveBeenCalled();
      });

      vi.useFakeTimers();

      await client.emit({
        type: 'message.part.updated',
        properties: {
          part: createTaskToolPart({
            status: 'completed',
            input: { background: true },
            metadata: { sessionId: 'ses_child_1' },
            output: '<task id="job_1" state="running" />',
          }),
        },
      });
      await client.emit({
        type: 'session.idle',
        properties: { sessionID: 'ses_child_1' },
      });

      await vi.advanceTimersByTimeAsync(SETTLEMENT_GRACE_MS * 3);

      expect(client.abort).not.toHaveBeenCalled();
    } finally {
      harness.dispose();
    }
  });

  it('cancels pending recovery when the parent turn finishes', async () => {
    const { client, harness } = createHarness();

    try {
      await connectHarness(harness, client);
      vi.useFakeTimers();
      await armSpawn(client, harness);

      await client.emit({
        type: 'session.idle',
        properties: { sessionID: 'ses_child_1' },
      });
      // Parent turn finish tears down foreground spawn tracking, and with it
      // the pending recovery.
      await client.emit({
        type: 'session.idle',
        properties: { sessionID: 'ses_1' },
      });

      await vi.advanceTimersByTimeAsync(SETTLEMENT_GRACE_MS * 3);

      expect(client.abort).not.toHaveBeenCalled();
    } finally {
      harness.dispose();
    }
  });

  it('cancels pending recovery on dispose', async () => {
    const { client, harness } = createHarness();

    try {
      await connectHarness(harness, client);
      vi.useFakeTimers();
      await armSpawn(client, harness);

      await client.emit({
        type: 'session.idle',
        properties: { sessionID: 'ses_child_1' },
      });

      harness.dispose();
      await vi.advanceTimersByTimeAsync(SETTLEMENT_GRACE_MS * 3);

      expect(client.abort).not.toHaveBeenCalled();
    } finally {
      harness.dispose();
    }
  });
});

describe('OpenCode subagent live activity', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('folds child tool events into a subagent_activity update on the spawn row', async () => {
    const { client, harness } = createHarness();
    const outputs: Array<Record<string, unknown>> = [];
    harness.on('runtimeOutput', (event) => {
      outputs.push(event as unknown as Record<string, unknown>);
    });

    try {
      await connectHarness(harness, client);
      await armSpawn(client, harness);
      await client.emit({
        type: 'message.part.updated',
        properties: {
          part: createChildToolPart({
            callId: 'child_call_1',
            command: 'agent-browser screenshot --full-page',
          }),
        },
      });

      const activity = subagentActivityEvents(outputs);
      expect(activity).toHaveLength(1);
      const payload = activity[0]!.payload as Record<string, unknown>;
      expect(payload.toolCallId).toBe('call_task_1');
      const details = payload.subagentActivity as Record<string, unknown>;
      expect(details.agentType).toBe('proof-runner');
      expect(details.lastAction).toContain('agent-browser screenshot');
      expect(details.toolCallCount).toBe(1);
    } finally {
      await harness.dispose();
    }
  });

  it('folds child assistant text into the subagent activity update before message metadata arrives', async () => {
    const { client, harness } = createHarness();
    const outputs: Array<Record<string, unknown>> = [];
    harness.on('runtimeOutput', (event) => {
      outputs.push(event as unknown as Record<string, unknown>);
    });

    try {
      await connectHarness(harness, client);
      await armSpawn(client, harness);
      await client.emit({
        type: 'message.part.updated',
        properties: {
          part: createChildTextPart('The latest child response.', 'assistant'),
        },
      });
      await client.emit({
        type: 'message.part.updated',
        properties: {
          part: createChildTextPart('The final child response.', 'assistant'),
        },
      });

      const activity = subagentActivityEvents(outputs);
      expect(activity).toHaveLength(1);
      const details = (activity[0]!.payload as Record<string, unknown>)
        .subagentActivity as Record<string, unknown>;
      expect(details.lastMessage).toBe('The latest child response.');
    } finally {
      await harness.dispose();
    }
  });

  it('throttles streamed child text instead of emitting once per token', async () => {
    const { client, harness } = createHarness();
    const outputs: Array<Record<string, unknown>> = [];
    harness.on('runtimeOutput', (event) => {
      outputs.push(event as unknown as Record<string, unknown>);
    });

    try {
      await connectHarness(harness, client);
      vi.useFakeTimers();
      await armSpawn(client, harness);

      // Text parts carry the full accumulated message, so a streamed response
      // arrives as a growing prefix on every token.
      for (const text of ['The', 'The final', 'The final child response.']) {
        await client.emit({
          type: 'message.part.updated',
          properties: {
            part: createChildTextPart(text, 'assistant'),
          },
        });
      }

      expect(subagentActivityEvents(outputs)).toHaveLength(1);

      vi.advanceTimersByTime(6_000);
      await client.emit({
        type: 'message.part.updated',
        properties: {
          part: createChildTextPart(
            'The final child response. Done.',
            'assistant',
          ),
        },
      });

      const activity = subagentActivityEvents(outputs);
      expect(activity).toHaveLength(2);
      const details = (activity[1]!.payload as Record<string, unknown>)
        .subagentActivity as Record<string, unknown>;
      expect(details.lastMessage).toBe('The final child response. Done.');
    } finally {
      await harness.dispose();
    }
  });

  it('keeps the last child message in terminal activity when task output is empty', async () => {
    const { client, harness } = createHarness();
    const outputs: Array<Record<string, unknown>> = [];
    harness.on('runtimeOutput', (event) => {
      outputs.push(event as unknown as Record<string, unknown>);
    });

    try {
      await connectHarness(harness, client);
      await armSpawn(client, harness);
      await client.emit({
        type: 'message.updated',
        properties: {
          info: {
            id: 'msg_child_1',
            sessionID: 'ses_child_1',
            role: 'assistant',
            time: { created: 1 },
          },
        },
      });
      await client.emit({
        type: 'message.part.updated',
        properties: {
          part: createChildTextPart('The child response to preserve.'),
        },
      });
      await client.emit({
        type: 'message.part.updated',
        properties: {
          part: createTaskToolPart({
            status: 'completed',
            metadata: { sessionId: 'ses_child_1' },
          }),
        },
      });

      const terminal = outputs.find((event) => {
        const payload = event.payload as Record<string, unknown>;
        return payload.status === 'completed';
      });
      const activity = (terminal?.payload as Record<string, unknown>)
        .subagentActivity as Record<string, unknown>;

      expect(activity.lastMessage).toBe('The child response to preserve.');
    } finally {
      await harness.dispose();
    }
  });

  it('throttles activity emissions and keeps counting child tool calls', async () => {
    const { client, harness } = createHarness();
    const outputs: Array<Record<string, unknown>> = [];
    harness.on('runtimeOutput', (event) => {
      outputs.push(event as unknown as Record<string, unknown>);
    });

    try {
      await connectHarness(harness, client);
      vi.useFakeTimers();
      await armSpawn(client, harness);
      await client.emit({
        type: 'message.part.updated',
        properties: {
          part: createChildToolPart({ callId: 'c1', command: 'ls' }),
        },
      });
      await client.emit({
        type: 'message.part.updated',
        properties: {
          part: createChildToolPart({ callId: 'c2', command: 'pwd' }),
        },
      });

      expect(subagentActivityEvents(outputs)).toHaveLength(1);

      vi.advanceTimersByTime(6_000);
      await client.emit({
        type: 'message.part.updated',
        properties: {
          part: createChildToolPart({ callId: 'c3', command: 'date' }),
        },
      });

      const activity = subagentActivityEvents(outputs);
      expect(activity).toHaveLength(2);
      const details = (activity[1]!.payload as Record<string, unknown>)
        .subagentActivity as Record<string, unknown>;
      expect(details.toolCallCount).toBe(3);
    } finally {
      await harness.dispose();
    }
  });

  it('ignores tool events from untracked child sessions', async () => {
    const { client, harness } = createHarness();
    const outputs: Array<Record<string, unknown>> = [];
    harness.on('runtimeOutput', (event) => {
      outputs.push(event as unknown as Record<string, unknown>);
    });

    try {
      await connectHarness(harness, client);
      await client.emit({
        type: 'message.part.updated',
        properties: {
          part: {
            ...createChildToolPart({ callId: 'cx', command: 'ls' }),
            sessionID: 'ses_unknown',
          },
        },
      });

      expect(subagentActivityEvents(outputs)).toHaveLength(0);
    } finally {
      await harness.dispose();
    }
  });
});
