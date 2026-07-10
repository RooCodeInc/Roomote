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
const SUBAGENT_TASK_TIMEOUT_MS = 60_000;

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

function createHarness(
  client = new FakeOpenCodeServerClient(),
  overrides: {
    subagentTaskInactivityTimeoutMs?: number;
  } = {},
) {
  const logger = createLogger();
  const harness = new OpenCodeServerHarness({
    client: client as unknown as OpenCodeServerClient,
    workspacePath: '/tmp/workspace',
    logger,
    model: TEST_OPENCODE_MODEL,
    eventStreamReadyTimeoutMs: 100,
    subagentTaskUnobservedTimeoutMs: SUBAGENT_TASK_TIMEOUT_MS,
    subagentTaskInactivityTimeoutMs: SUBAGENT_TASK_TIMEOUT_MS,
    ...overrides,
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

// Mirrors the real OpenCode 1.17.8 shape observed live: subagent spawns
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

const SUBAGENT_INACTIVITY_TIMEOUT_MS = 10_000;

function createChildTextPart(text: string) {
  return {
    id: 'prt_child_text_1',
    sessionID: 'ses_child_1',
    messageID: 'msg_child_1',
    type: 'text',
    text,
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

describe('OpenCode subagent watchdog', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('aborts the child session recorded on the task tool part when it becomes inactive', async () => {
    const { client, harness, logger } = createHarness();

    try {
      await connectHarness(harness, client);
      vi.useFakeTimers();

      await client.emit({
        type: 'message.part.updated',
        properties: {
          part: createTaskToolPart({
            status: 'running',
            metadata: {
              sessionId: 'ses_child_1',
              parentSessionId: 'ses_1',
            },
          }),
        },
      });

      // Just before the timeout nothing happens.
      await vi.advanceTimersByTimeAsync(SUBAGENT_TASK_TIMEOUT_MS - 1);
      expect(client.abort).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);

      // The child session id came from the part metadata, so no children()
      // lookup is needed.
      expect(client.children).not.toHaveBeenCalled();
      expect(client.abort).toHaveBeenCalledTimes(1);
      expect(client.abort).toHaveBeenCalledWith(
        expect.objectContaining({ sessionId: 'ses_child_1' }),
      );
      // Never abort the parent session.
      expect(client.abort).not.toHaveBeenCalledWith(
        expect.objectContaining({ sessionId: 'ses_1' }),
      );
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('stalled with no child-session events'),
      );
    } finally {
      harness.dispose();
    }
  });

  it('falls back to listing children when the task tool part has no child session id', async () => {
    const { client, harness } = createHarness();

    try {
      await connectHarness(harness, client);
      vi.useFakeTimers();

      client.children.mockResolvedValueOnce([
        { id: 'child_1', parentID: 'ses_1' },
        { id: 'child_2', parentID: 'ses_1' },
      ]);

      await client.emit({
        type: 'message.part.updated',
        properties: { part: createTaskToolPart({ status: 'pending' }) },
      });

      await vi.advanceTimersByTimeAsync(SUBAGENT_TASK_TIMEOUT_MS / 2);
      await client.emit({
        type: 'message.part.updated',
        properties: { part: createTaskToolPart({ status: 'pending' }) },
      });
      await vi.advanceTimersByTimeAsync(SUBAGENT_TASK_TIMEOUT_MS / 2);

      // Parent-side progress keeps an unobservable launch alive too.
      expect(client.children).not.toHaveBeenCalled();
      expect(client.abort).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(SUBAGENT_TASK_TIMEOUT_MS / 2);

      expect(client.children).toHaveBeenCalledTimes(1);
      expect(client.children).toHaveBeenCalledWith(
        expect.objectContaining({ sessionId: 'ses_1' }),
      );
      expect(client.abort).toHaveBeenCalledTimes(2);
      expect(client.abort).toHaveBeenCalledWith(
        expect.objectContaining({ sessionId: 'child_1' }),
      );
      expect(client.abort).toHaveBeenCalledWith(
        expect.objectContaining({ sessionId: 'child_2' }),
      );
    } finally {
      harness.dispose();
    }
  });

  it('does not abort sibling child sessions still owned by a live watchdog', async () => {
    const { client, harness } = createHarness();

    try {
      await connectHarness(harness, client);
      vi.useFakeTimers();

      // Watchdog A: no child session id ever captured, so its expiry takes the
      // list-all-children fallback.
      await client.emit({
        type: 'message.part.updated',
        properties: {
          part: createTaskToolPart({ status: 'pending', callId: 'call_A' }),
        },
      });

      // Watchdog B is armed half a window later, so at A's deadline B is still
      // live (its own deadline is further out). B owns child session
      // ses_child_B.
      await vi.advanceTimersByTimeAsync(SUBAGENT_TASK_TIMEOUT_MS / 2);
      await client.emit({
        type: 'message.part.updated',
        properties: {
          part: createTaskToolPart({
            status: 'running',
            callId: 'call_B',
            metadata: { sessionId: 'ses_child_B' },
          }),
        },
      });

      // The parent session lists both children when A's fallback runs.
      client.children.mockResolvedValueOnce([
        { id: 'ses_child_A', parentID: 'ses_1' },
        { id: 'ses_child_B', parentID: 'ses_1' },
      ]);

      // Advance to A's unobservable-launch deadline (B still has half a
      // window left).
      await vi.advanceTimersByTimeAsync(SUBAGENT_TASK_TIMEOUT_MS / 2);

      expect(client.children).toHaveBeenCalledTimes(1);
      // Only the orphaned child is aborted; the sibling owned by live watchdog
      // B is spared.
      expect(client.abort).toHaveBeenCalledTimes(1);
      expect(client.abort).toHaveBeenCalledWith(
        expect.objectContaining({ sessionId: 'ses_child_A' }),
      );
      expect(client.abort).not.toHaveBeenCalledWith(
        expect.objectContaining({ sessionId: 'ses_child_B' }),
      );
    } finally {
      harness.dispose();
    }
  });

  it('disarms a watchdog when its child session errors (aborted elsewhere)', async () => {
    const { client, harness } = createHarness();

    try {
      await connectHarness(harness, client);

      // Establish the parent session so the child error routes through the
      // child-session branch of the dispatcher.
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
            status: 'running',
            metadata: { sessionId: 'ses_child_1' },
          }),
        },
      });

      // The child is aborted by some other path; OpenCode surfaces that as a
      // session.error attributed to the child. The watchdog must disarm so it
      // never fires its own deadline later.
      await client.emit({
        type: 'session.error',
        properties: {
          sessionID: 'ses_child_1',
          error: { name: 'MessageAbortedError' },
        },
      });

      await vi.advanceTimersByTimeAsync(SUBAGENT_TASK_TIMEOUT_MS * 2);

      expect(client.children).not.toHaveBeenCalled();
      expect(client.abort).not.toHaveBeenCalled();
    } finally {
      harness.dispose();
    }
  });

  it('keeps a single timer across re-emits and picks up the child session id from later updates', async () => {
    const { client, harness } = createHarness();

    try {
      await connectHarness(harness, client);
      vi.useFakeTimers();

      // First update: pending, no metadata yet.
      await client.emit({
        type: 'message.part.updated',
        properties: { part: createTaskToolPart({ status: 'pending' }) },
      });
      await vi.advanceTimersByTimeAsync(SUBAGENT_TASK_TIMEOUT_MS / 2);
      // Second update: running with the child session id. Must not duplicate
      // the timer, and its observed progress slides the inactivity deadline.
      await client.emit({
        type: 'message.part.updated',
        properties: {
          part: createTaskToolPart({
            status: 'running',
            metadata: { sessionId: 'ses_child_1' },
          }),
        },
      });
      await vi.advanceTimersByTimeAsync(SUBAGENT_TASK_TIMEOUT_MS / 2);

      expect(client.children).not.toHaveBeenCalled();
      expect(client.abort).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(SUBAGENT_TASK_TIMEOUT_MS / 2);

      expect(client.abort).toHaveBeenCalledTimes(1);
      expect(client.abort).toHaveBeenCalledWith(
        expect.objectContaining({ sessionId: 'ses_child_1' }),
      );

      await vi.advanceTimersByTimeAsync(SUBAGENT_TASK_TIMEOUT_MS * 2);
      expect(client.abort).toHaveBeenCalledTimes(1);
    } finally {
      harness.dispose();
    }
  });

  it('clears the watchdog when the task tool part reaches a terminal status', async () => {
    const { client, harness } = createHarness();

    try {
      await connectHarness(harness, client);
      vi.useFakeTimers();

      await client.emit({
        type: 'message.part.updated',
        properties: {
          part: createTaskToolPart({
            status: 'running',
            metadata: { sessionId: 'ses_child_1' },
          }),
        },
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

      await vi.advanceTimersByTimeAsync(SUBAGENT_TASK_TIMEOUT_MS * 2);

      expect(client.children).not.toHaveBeenCalled();
      expect(client.abort).not.toHaveBeenCalled();
    } finally {
      harness.dispose();
    }
  });

  it('keeps a completed foreground task tool part disarming the watchdog even when metadata is present', async () => {
    const { client, harness } = createHarness();

    try {
      await connectHarness(harness, client);
      vi.useFakeTimers();

      await client.emit({
        type: 'message.part.updated',
        properties: {
          part: createTaskToolPart({
            status: 'running',
            metadata: { sessionId: 'ses_child_1' },
          }),
        },
      });
      // No background flag anywhere: completion is terminal for the spawn.
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

      await vi.advanceTimersByTimeAsync(SUBAGENT_TASK_TIMEOUT_MS * 2);

      expect(client.children).not.toHaveBeenCalled();
      expect(client.abort).not.toHaveBeenCalled();
    } finally {
      harness.dispose();
    }
  });

  it('keeps the watchdog armed when a background task tool part completes', async () => {
    const { client, harness } = createHarness();

    try {
      await connectHarness(harness, client);
      vi.useFakeTimers();

      // A background launch's tool call completes immediately while the child
      // session keeps working, so terminal status must not disarm the
      // watchdog.
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

      await vi.advanceTimersByTimeAsync(SUBAGENT_TASK_TIMEOUT_MS - 1);
      expect(client.abort).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);

      expect(client.children).not.toHaveBeenCalled();
      expect(client.abort).toHaveBeenCalledTimes(1);
      expect(client.abort).toHaveBeenCalledWith(
        expect.objectContaining({ sessionId: 'ses_child_1' }),
      );
    } finally {
      harness.dispose();
    }
  });

  it('detects background launches and the child session id from state.metadata alone', async () => {
    const { client, harness } = createHarness();

    try {
      await connectHarness(harness, client);
      vi.useFakeTimers();

      // Some OpenCode builds only report the launch as background metadata
      // with a `jobId` instead of `sessionId`/`input.background`.
      await client.emit({
        type: 'message.part.updated',
        properties: {
          part: createTaskToolPart({
            status: 'completed',
            metadata: { background: true, jobId: 'ses_child_1' },
            output: '<task id="job_1" state="running" />',
          }),
        },
      });

      await vi.advanceTimersByTimeAsync(SUBAGENT_TASK_TIMEOUT_MS);

      expect(client.children).not.toHaveBeenCalled();
      expect(client.abort).toHaveBeenCalledTimes(1);
      expect(client.abort).toHaveBeenCalledWith(
        expect.objectContaining({ sessionId: 'ses_child_1' }),
      );
    } finally {
      harness.dispose();
    }
  });

  it('disarms the background watchdog on child session idle without finishing the parent turn', async () => {
    const { client, harness } = createHarness();
    const taskEvents: TaskEvent[] = [];
    harness.subscribe((event) => taskEvents.push(event));

    try {
      await connectHarness(harness, client);

      // Establish the parent session so the child idle is routed through the
      // dispatcher's child-session branch (the production path) rather than
      // falling through to the parent handlers.
      harness.sendCommand({
        commandName: TaskCommandName.StartNewTask,
        data: { text: 'Do work.', visibleInTranscript: true },
      });
      await vi.waitFor(() => {
        expect(client.createSession).toHaveBeenCalled();
      });

      vi.useFakeTimers();

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
      // signal: it disarms the watchdog and must not finish the parent turn.
      await client.emit({
        type: 'session.idle',
        properties: { sessionID: 'ses_child_1' },
      });

      await vi.advanceTimersByTimeAsync(SUBAGENT_TASK_TIMEOUT_MS * 2);

      expect(client.children).not.toHaveBeenCalled();
      expect(client.abort).not.toHaveBeenCalled();
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
    } finally {
      harness.dispose();
    }
  });

  it('keeps the background watchdog armed across parent turn finish and aborts the hung child', async () => {
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

      // The parent turn finishes right after launching the background proof
      // and posting the closeout — the canonical non-blocking delivery shape.
      await client.emit({
        type: 'session.idle',
        properties: { sessionID: 'ses_1' },
      });

      // Turn finish must not disarm the background watchdog: the hung child
      // is still aborted when the timeout elapses.
      await vi.advanceTimersByTimeAsync(SUBAGENT_TASK_TIMEOUT_MS + 1_000);

      expect(client.abort).toHaveBeenCalledWith(
        expect.objectContaining({ sessionId: 'ses_child_1' }),
      );
    } finally {
      harness.dispose();
    }
  });

  it('still clears foreground watchdogs when the parent turn finishes', async () => {
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

      // Foreground spawn still running when the turn ends (e.g. an abort
      // raced the tool result): turn finish disarms its watchdog.
      await client.emit({
        type: 'message.part.updated',
        properties: {
          part: createTaskToolPart({
            status: 'running',
            metadata: { sessionId: 'ses_child_1' },
          }),
        },
      });
      await client.emit({
        type: 'session.idle',
        properties: { sessionID: 'ses_1' },
      });

      await vi.advanceTimersByTimeAsync(SUBAGENT_TASK_TIMEOUT_MS * 2);

      expect(client.abort).not.toHaveBeenCalled();
      expect(client.children).not.toHaveBeenCalled();
    } finally {
      harness.dispose();
    }
  });

  it('cleans the child-session key map when a background watchdog expires', async () => {
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

      vi.useFakeTimers();

      await client.emit({
        type: 'message.part.updated',
        properties: {
          part: createTaskToolPart({
            status: 'completed',
            input: { background: true },
            metadata: { sessionId: 'ses_child_1' },
          }),
        },
      });

      await vi.advanceTimersByTimeAsync(SUBAGENT_TASK_TIMEOUT_MS + 1_000);
      expect(client.abort).toHaveBeenCalledTimes(1);

      // Expiry removed the child-session mapping: a late child idle is inert
      // (no second abort, no parent-turn side effects).
      await client.emit({
        type: 'session.idle',
        properties: { sessionID: 'ses_child_1' },
      });
      expect(client.abort).toHaveBeenCalledTimes(1);
      expect(
        taskEvents.filter(
          (event) => event.eventName === TaskEventName.TaskCompleted,
        ).length,
      ).toBeLessThanOrEqual(1);
    } finally {
      harness.dispose();
    }
  });

  it('arms the watchdog for subtask parts as well', async () => {
    const { client, harness } = createHarness();

    try {
      await connectHarness(harness, client);
      vi.useFakeTimers();

      client.children.mockResolvedValueOnce([
        { id: 'child_1', parentID: 'ses_1' },
      ]);

      await client.emit({
        type: 'message.part.updated',
        properties: { part: createSubtaskPart() },
      });

      await vi.advanceTimersByTimeAsync(SUBAGENT_TASK_TIMEOUT_MS);

      expect(client.children).toHaveBeenCalledTimes(1);
      expect(client.abort).toHaveBeenCalledWith(
        expect.objectContaining({ sessionId: 'child_1' }),
      );
    } finally {
      harness.dispose();
    }
  });

  it('clears the watchdog when a subtask part reaches a terminal status', async () => {
    const { client, harness } = createHarness();

    try {
      await connectHarness(harness, client);
      vi.useFakeTimers();

      await client.emit({
        type: 'message.part.updated',
        properties: { part: createSubtaskPart() },
      });
      await client.emit({
        type: 'message.part.updated',
        properties: {
          part: createSubtaskPart({ state: { status: 'completed' } }),
        },
      });

      await vi.advanceTimersByTimeAsync(SUBAGENT_TASK_TIMEOUT_MS * 2);

      expect(client.children).not.toHaveBeenCalled();
      expect(client.abort).not.toHaveBeenCalled();
    } finally {
      harness.dispose();
    }
  });

  it('clears pending watchdogs when the turn finishes', async () => {
    const { client, harness } = createHarness();

    try {
      await connectHarness(harness, client);
      vi.useFakeTimers();

      await client.emit({
        type: 'session.status',
        properties: { sessionID: 'ses_1', status: { type: 'busy' } },
      });
      await client.emit({
        type: 'message.part.updated',
        properties: { part: createTaskToolPart({ status: 'running' }) },
      });
      // Turn completion tears down execute-tool progress and subagent
      // watchdogs together.
      await client.emit({
        type: 'session.status',
        properties: { sessionID: 'ses_1', status: { type: 'idle' } },
      });

      await vi.advanceTimersByTimeAsync(SUBAGENT_TASK_TIMEOUT_MS * 2);

      expect(client.children).not.toHaveBeenCalled();
      expect(client.abort).not.toHaveBeenCalled();
    } finally {
      harness.dispose();
    }
  });

  it('only logs when listing or aborting child sessions fails', async () => {
    const { client, harness, logger } = createHarness();

    try {
      await connectHarness(harness, client);
      vi.useFakeTimers();

      client.children.mockRejectedValueOnce(new Error('children failed'));

      await client.emit({
        type: 'message.part.updated',
        properties: { part: createTaskToolPart({ status: 'running' }) },
      });
      await vi.advanceTimersByTimeAsync(SUBAGENT_TASK_TIMEOUT_MS);

      expect(client.children).toHaveBeenCalledTimes(1);
      expect(client.abort).not.toHaveBeenCalled();
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('Failed to list OpenCode child sessions'),
      );
      expect(logger.error).not.toHaveBeenCalled();
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

      const activity = outputs.filter(
        (event) =>
          (event.payload as Record<string, unknown>)?.progressKind ===
          'subagent_activity',
      );
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

      let activity = outputs.filter(
        (event) =>
          (event.payload as Record<string, unknown>)?.progressKind ===
          'subagent_activity',
      );
      expect(activity).toHaveLength(1);

      vi.advanceTimersByTime(6_000);
      await client.emit({
        type: 'message.part.updated',
        properties: {
          part: createChildToolPart({ callId: 'c3', command: 'date' }),
        },
      });

      activity = outputs.filter(
        (event) =>
          (event.payload as Record<string, unknown>)?.progressKind ===
          'subagent_activity',
      );
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

      expect(
        outputs.filter(
          (event) =>
            (event.payload as Record<string, unknown>)?.progressKind ===
            'subagent_activity',
        ),
      ).toHaveLength(0);
    } finally {
      await harness.dispose();
    }
  });
});

describe('OpenCode subagent inactivity deadline', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  function createInactivityHarness() {
    return createHarness(new FakeOpenCodeServerClient(), {
      subagentTaskInactivityTimeoutMs: SUBAGENT_INACTIVITY_TIMEOUT_MS,
    });
  }

  it('aborts a child session that stops emitting events at the inactivity deadline', async () => {
    const { client, harness, logger } = createInactivityHarness();

    try {
      await connectHarness(harness, client);
      vi.useFakeTimers();
      await armSpawn(client, harness);

      await vi.advanceTimersByTimeAsync(SUBAGENT_INACTIVITY_TIMEOUT_MS - 1);
      expect(client.abort).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);

      expect(client.abort).toHaveBeenCalledTimes(1);
      expect(client.abort).toHaveBeenCalledWith(
        expect.objectContaining({ sessionId: 'ses_child_1' }),
      );
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('stalled with no child-session events'),
      );
    } finally {
      await harness.dispose();
    }
  });

  it('slides the inactivity deadline forward on child-session events', async () => {
    const { client, harness } = createInactivityHarness();

    try {
      await connectHarness(harness, client);
      vi.useFakeTimers();
      await armSpawn(client, harness);

      await vi.advanceTimersByTimeAsync(8_000);
      await client.emit({
        type: 'message.part.updated',
        properties: { part: createChildTextPart('still capturing') },
      });

      // The deadline now measures from the last child event, not the spawn.
      await vi.advanceTimersByTimeAsync(SUBAGENT_INACTIVITY_TIMEOUT_MS - 1);
      expect(client.abort).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      expect(client.abort).toHaveBeenCalledTimes(1);
      expect(client.abort).toHaveBeenCalledWith(
        expect.objectContaining({ sessionId: 'ses_child_1' }),
      );
    } finally {
      await harness.dispose();
    }
  });

  it('keeps an active child alive indefinitely while it continues emitting events', async () => {
    const { client, harness } = createInactivityHarness();

    try {
      await connectHarness(harness, client);
      vi.useFakeTimers();
      await armSpawn(client, harness);

      // Child streams an event every half inactivity window for well beyond
      // the old wall-clock deadline.
      const stepMs = SUBAGENT_INACTIVITY_TIMEOUT_MS / 2;
      for (
        let elapsedMs = stepMs;
        elapsedMs < SUBAGENT_TASK_TIMEOUT_MS * 2;
        elapsedMs += stepMs
      ) {
        await vi.advanceTimersByTimeAsync(stepMs);
        await client.emit({
          type: 'message.part.updated',
          properties: { part: createChildTextPart('still capturing') },
        });
      }

      expect(client.abort).not.toHaveBeenCalled();
    } finally {
      await harness.dispose();
    }
  });

  it('does not impose a wall-clock timeout while a child tool call is in flight', async () => {
    const { client, harness } = createInactivityHarness();

    try {
      await connectHarness(harness, client);
      vi.useFakeTimers();
      await armSpawn(client, harness);

      // A silently long-running tool must not be mistaken for a wedged child.
      await client.emit({
        type: 'message.part.updated',
        properties: {
          part: createChildToolPart({ callId: 'c1', command: 'pnpm build' }),
        },
      });

      await vi.advanceTimersByTimeAsync(SUBAGENT_TASK_TIMEOUT_MS * 2);
      expect(client.abort).not.toHaveBeenCalled();
    } finally {
      await harness.dispose();
    }
  });

  it('resumes the inactivity deadline when the running child tool completes', async () => {
    const { client, harness, logger } = createInactivityHarness();

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
      await vi.advanceTimersByTimeAsync(SUBAGENT_INACTIVITY_TIMEOUT_MS * 3);
      expect(client.abort).not.toHaveBeenCalled();

      // Tool completes, then the child goes silent: the idle clock restarts
      // at the completion event and expires one window later.
      await client.emit({
        type: 'message.part.updated',
        properties: {
          part: createChildToolPart({ callId: 'c1', status: 'completed' }),
        },
      });

      await vi.advanceTimersByTimeAsync(SUBAGENT_INACTIVITY_TIMEOUT_MS - 1);
      expect(client.abort).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      expect(client.abort).toHaveBeenCalledTimes(1);
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('stalled with no child-session events'),
      );
    } finally {
      await harness.dispose();
    }
  });

  it('suspends the inactivity deadline for long-running non-shell tools (MCP calls)', async () => {
    const { client, harness } = createInactivityHarness();

    try {
      await connectHarness(harness, client);
      vi.useFakeTimers();
      await armSpawn(client, harness);

      await client.emit({
        type: 'message.part.updated',
        properties: {
          part: createChildToolPart({
            callId: 'c_mcp',
            tool: 'mcp__roomote__manage_artifacts',
          }),
        },
      });

      await vi.advanceTimersByTimeAsync(SUBAGENT_TASK_TIMEOUT_MS * 2);
      expect(client.abort).not.toHaveBeenCalled();
    } finally {
      await harness.dispose();
    }
  });

  it('treats a pending child tool call as in flight', async () => {
    const { client, harness } = createInactivityHarness();

    try {
      await connectHarness(harness, client);
      vi.useFakeTimers();
      await armSpawn(client, harness);

      await client.emit({
        type: 'message.part.updated',
        properties: {
          part: createChildToolPart({ callId: 'c1', status: 'pending' }),
        },
      });

      await vi.advanceTimersByTimeAsync(SUBAGENT_TASK_TIMEOUT_MS * 2);
      expect(client.abort).not.toHaveBeenCalled();
    } finally {
      await harness.dispose();
    }
  });

  it('treats a child tool part with no status as in flight (fails toward suspension)', async () => {
    const { client, harness } = createInactivityHarness();

    try {
      await connectHarness(harness, client);
      vi.useFakeTimers();
      await armSpawn(client, harness);

      const part = createChildToolPart({ callId: 'c1' }) as Record<
        string,
        unknown
      >;
      part.state = { input: {} };
      await client.emit({
        type: 'message.part.updated',
        properties: { part },
      });

      await vi.advanceTimersByTimeAsync(SUBAGENT_TASK_TIMEOUT_MS * 2);
      expect(client.abort).not.toHaveBeenCalled();
    } finally {
      await harness.dispose();
    }
  });

  it('resumes the inactivity deadline when the running child tool errors', async () => {
    const { client, harness, logger } = createInactivityHarness();

    try {
      await connectHarness(harness, client);
      vi.useFakeTimers();
      await armSpawn(client, harness);

      await client.emit({
        type: 'message.part.updated',
        properties: { part: createChildToolPart({ callId: 'c1' }) },
      });
      await vi.advanceTimersByTimeAsync(SUBAGENT_INACTIVITY_TIMEOUT_MS * 2);
      expect(client.abort).not.toHaveBeenCalled();

      // The tool fails (e.g. OpenCode's own shell timeout killed it); the
      // idle clock restarts at the error event.
      await client.emit({
        type: 'message.part.updated',
        properties: {
          part: createChildToolPart({ callId: 'c1', status: 'error' }),
        },
      });

      await vi.advanceTimersByTimeAsync(SUBAGENT_INACTIVITY_TIMEOUT_MS - 1);
      expect(client.abort).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      expect(client.abort).toHaveBeenCalledTimes(1);
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('stalled with no child-session events'),
      );
    } finally {
      await harness.dispose();
    }
  });

  it('does not enforce the inactivity deadline before a child session id is known', async () => {
    const { client, harness } = createInactivityHarness();

    try {
      await connectHarness(harness, client);
      vi.useFakeTimers();

      // Spawn with no child session id: there is no activity feed to judge
      // liveness by, so the unobservable-launch fallback applies.
      await client.emit({
        type: 'message.part.updated',
        properties: { part: createTaskToolPart({ status: 'pending' }) },
      });

      await vi.advanceTimersByTimeAsync(SUBAGENT_TASK_TIMEOUT_MS - 1);
      expect(client.children).not.toHaveBeenCalled();
      expect(client.abort).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      expect(client.children).toHaveBeenCalledTimes(1);
    } finally {
      await harness.dispose();
    }
  });
});
