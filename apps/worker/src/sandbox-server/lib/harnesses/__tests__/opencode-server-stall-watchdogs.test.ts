import {
  ACP_ENVELOPE_EVENT_TYPES,
  TaskEventName,
  type AcpPersistedEnvelope,
  type TaskEvent,
} from '@roomote/types';

import { TaskCommandName } from '../../harness';
import type { OpenCodeServerClient } from '../opencode-server/client';
import { OpenCodeServerHarness } from '../opencode-server/harness';
import type {
  OpenCodeGlobalEvent,
  OpenCodeSessionMessage,
} from '../opencode-server/types';

const TEST_OPENCODE_MODEL = 'test-provider/main-model';
const STEER_PICKUP_TIMEOUT_MS = 5_000;
const TURN_STALL_TIMEOUT_MS = 60_000;
const STEER_TEXT = 'Use this newer instruction instead.';

class FakeOpenCodeServerClient {
  private eventHandler:
    | ((event: OpenCodeGlobalEvent) => void | Promise<void>)
    | undefined;

  health = vi.fn(async () => ({ healthy: true as const, version: 'test' }));
  createSession = vi.fn(async () => ({ id: 'ses_1', title: 'test' }));
  promptAsync = vi.fn(async (_options: unknown) => undefined);
  messages = vi.fn(async () => [] as OpenCodeSessionMessage[]);
  message = vi.fn<() => Promise<OpenCodeSessionMessage>>();
  abort = vi.fn(async () => true);
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

function createHarness(client = new FakeOpenCodeServerClient()) {
  const logger = createLogger();
  const harness = new OpenCodeServerHarness({
    client: client as unknown as OpenCodeServerClient,
    workspacePath: '/tmp/workspace',
    logger,
    model: TEST_OPENCODE_MODEL,
    eventStreamReadyTimeoutMs: 100,
    steerPickupTimeoutMs: STEER_PICKUP_TIMEOUT_MS,
    turnStallTimeoutMs: TURN_STALL_TIMEOUT_MS,
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

async function startTask(
  client: FakeOpenCodeServerClient,
  harness: OpenCodeServerHarness,
): Promise<void> {
  harness.sendCommand({
    commandName: TaskCommandName.StartNewTask,
    data: { text: 'Start work.', visibleInTranscript: true },
  });
  await vi.waitFor(() => {
    expect(client.promptAsync).toHaveBeenCalledTimes(1);
  });
}

async function injectSteer(
  client: FakeOpenCodeServerClient,
  harness: OpenCodeServerHarness,
): Promise<void> {
  harness.sendCommand({
    commandName: TaskCommandName.SendMessage,
    data: {
      text: STEER_TEXT,
      autoSteerWhenQueued: true,
      visibleInTranscript: true,
    },
  });
  await vi.waitFor(() => {
    expect(client.promptAsync).toHaveBeenCalledTimes(2);
  });
  expect(client.abort).not.toHaveBeenCalled();
}

function assistantTextPartEvent(): OpenCodeGlobalEvent {
  return {
    type: 'message.part.updated',
    properties: {
      info: { id: 'msg_a1', role: 'assistant' },
      part: {
        id: 'prt_a1',
        sessionID: 'ses_1',
        messageID: 'msg_a1',
        type: 'text',
        text: 'Working on it.',
      },
    },
  };
}

function mcpToolPart(status: string) {
  return {
    id: 'prt_mcp_1',
    sessionID: 'ses_1',
    messageID: 'msg_a1',
    type: 'tool',
    tool: 'mcp__browser__long_capture',
    callID: 'call_mcp_1',
    state: { status, input: {} },
  };
}

function assistantMessageWithParts(
  parts: Array<Record<string, unknown>>,
): OpenCodeSessionMessage {
  return {
    info: {
      id: 'msg_a1',
      sessionID: 'ses_1',
      role: 'assistant',
      time: { created: 1 },
    },
    parts,
  } as unknown as OpenCodeSessionMessage;
}

function suppressedAbortErrorEvent(): OpenCodeGlobalEvent {
  return {
    type: 'session.error',
    properties: {
      sessionID: 'ses_1',
      error: { name: 'MessageAbortedError', data: { message: 'Aborted' } },
    },
  };
}

describe('OpenCode steer pickup watchdog', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('escalates a silently dropped native steer to abort-and-replay', async () => {
    const { client, harness } = createHarness();
    const taskEvents: TaskEvent[] = [];
    const persistedEnvelopes: AcpPersistedEnvelope[] = [];
    harness.subscribe((event) => taskEvents.push(event));
    harness.subscribeRuntimePersistedEnvelope((envelope) =>
      persistedEnvelopes.push(envelope),
    );

    try {
      await connectHarness(harness, client);
      vi.useFakeTimers();
      await startTask(client, harness);
      await injectSteer(client, harness);

      // The injection succeeded, but the turn is wedged inside a stalled LLM
      // stream: no events arrive at all, so OpenCode never reaches the loop
      // step boundary that would read the injected prompt.
      await vi.advanceTimersByTimeAsync(STEER_PICKUP_TIMEOUT_MS);

      expect(client.abort).toHaveBeenCalledTimes(1);
      expect(client.abort).toHaveBeenCalledWith(
        expect.objectContaining({ sessionId: 'ses_1' }),
      );
      await vi.waitFor(() => {
        expect(client.promptAsync).toHaveBeenCalledTimes(3);
      });
      expect(client.promptAsync.mock.calls[2]?.[0]).toMatchObject({
        sessionId: 'ses_1',
        request: {
          parts: [{ type: 'text', text: STEER_TEXT }],
        },
      });

      // The steer's user prompt was already persisted visibly at injection
      // time; the escalated replay must not add a duplicate visible entry.
      const steerPrompts = persistedEnvelopes.filter(
        (envelope) =>
          envelope.eventType === ACP_ENVELOPE_EVENT_TYPES.UserPrompt &&
          envelope.contentBlocks.some(
            (block) => block.type === 'text' && block.text === STEER_TEXT,
          ),
      );
      expect(steerPrompts).toHaveLength(2);
      expect(
        steerPrompts.filter(
          (envelope) => envelope.visibleInTranscript !== false,
        ),
      ).toHaveLength(1);

      // The abort is the harness's own doing: the MessageAbortedError it
      // provokes must not become a terminal abort.
      await client.emit(suppressedAbortErrorEvent());
      expect(
        taskEvents.some(
          (event) => event.eventName === TaskEventName.TaskAborted,
        ),
      ).toBe(false);
    } finally {
      harness.dispose();
    }
  });

  it('does not escalate a steer once the turn shows progress', async () => {
    const { client, harness } = createHarness();

    try {
      await connectHarness(harness, client);
      vi.useFakeTimers();
      await startTask(client, harness);
      await injectSteer(client, harness);

      // Turn progress after the injection: the loop is alive and will reach
      // the injected prompt at its next step boundary on its own.
      await client.emit(assistantTextPartEvent());

      await vi.advanceTimersByTimeAsync(STEER_PICKUP_TIMEOUT_MS * 3);

      expect(client.abort).not.toHaveBeenCalled();
      expect(client.promptAsync).toHaveBeenCalledTimes(2);
    } finally {
      harness.dispose();
    }
  });

  it('does not escalate a steer after the turn completes', async () => {
    const { client, harness } = createHarness();

    try {
      await connectHarness(harness, client);
      vi.useFakeTimers();
      await startTask(client, harness);
      await injectSteer(client, harness);

      await client.emit({
        type: 'session.idle',
        properties: { sessionID: 'ses_1' },
      });

      await vi.advanceTimersByTimeAsync(STEER_PICKUP_TIMEOUT_MS * 3);

      expect(client.abort).not.toHaveBeenCalled();
      expect(client.promptAsync).toHaveBeenCalledTimes(2);
    } finally {
      harness.dispose();
    }
  });
});

describe('OpenCode turn stall watchdog', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('aborts a wedged turn, surfaces a retryable error, and ends the task', async () => {
    const { client, harness } = createHarness();
    const taskEvents: TaskEvent[] = [];
    const persistedEnvelopes: AcpPersistedEnvelope[] = [];
    harness.subscribe((event) => taskEvents.push(event));
    harness.subscribeRuntimePersistedEnvelope((envelope) =>
      persistedEnvelopes.push(envelope),
    );

    try {
      await connectHarness(harness, client);
      vi.useFakeTimers();
      await startTask(client, harness);
      // Re-baseline the activity clock (startTask's waitFor advances fake
      // time a little) so the window boundary below is exact.
      await client.emit(assistantTextPartEvent());

      await vi.advanceTimersByTimeAsync(TURN_STALL_TIMEOUT_MS - 1);
      expect(client.abort).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      await vi.waitFor(() => {
        expect(client.abort).toHaveBeenCalledTimes(1);
      });
      expect(client.abort).toHaveBeenCalledWith(
        expect.objectContaining({ sessionId: 'ses_1' }),
      );

      // A retryable stall notice lands in the transcript.
      expect(
        persistedEnvelopes.some((envelope) =>
          envelope.contentBlocks.some(
            (block) =>
              block.type === 'text' &&
              typeof block.text === 'string' &&
              block.text.includes('safe to retry'),
          ),
        ),
      ).toBe(true);

      // With nothing queued the task reaches a terminal state instead of
      // hanging "running" until the sandbox hard deadline.
      expect(
        taskEvents.filter(
          (event) => event.eventName === TaskEventName.TaskAborted,
        ),
      ).toHaveLength(1);

      // The MessageAbortedError provoked by the recovery abort stays
      // suppressed instead of surfacing a second error or terminal abort.
      await client.emit(suppressedAbortErrorEvent());
      expect(
        persistedEnvelopes.some((envelope) =>
          envelope.contentBlocks.some(
            (block) =>
              block.type === 'text' &&
              typeof block.text === 'string' &&
              block.text.includes('provider returned an error'),
          ),
        ),
      ).toBe(false);
      expect(
        taskEvents.filter(
          (event) => event.eventName === TaskEventName.TaskAborted,
        ),
      ).toHaveLength(1);
    } finally {
      harness.dispose();
    }
  });

  it('delivers queued follow-ups after recovering a wedged turn', async () => {
    const { client, harness } = createHarness();
    const taskEvents: TaskEvent[] = [];
    harness.subscribe((event) => taskEvents.push(event));

    try {
      await connectHarness(harness, client);
      vi.useFakeTimers();
      await startTask(client, harness);

      harness.sendCommand({
        commandName: TaskCommandName.SendMessage,
        data: { text: 'Queued follow-up.', visibleInTranscript: true },
      });
      await vi.waitFor(() => {
        expect(harness.getQueuedMessages()).toHaveLength(1);
      });

      await vi.advanceTimersByTimeAsync(TURN_STALL_TIMEOUT_MS);

      await vi.waitFor(() => {
        expect(client.promptAsync).toHaveBeenCalledTimes(2);
      });
      expect(client.abort).toHaveBeenCalledTimes(1);
      expect(client.promptAsync.mock.calls[1]?.[0]).toMatchObject({
        sessionId: 'ses_1',
        request: {
          parts: [{ type: 'text', text: 'Queued follow-up.' }],
        },
      });
      expect(harness.getQueuedMessages()).toEqual([]);
      // The run continues on the fresh turn; recovery is not a terminal
      // abort when there is queued work to deliver.
      expect(
        taskEvents.some(
          (event) => event.eventName === TaskEventName.TaskAborted,
        ),
      ).toBe(false);
    } finally {
      harness.dispose();
    }
  });

  it('measures the stall window from the latest session activity', async () => {
    const { client, harness } = createHarness();

    try {
      await connectHarness(harness, client);
      vi.useFakeTimers();
      await startTask(client, harness);

      await vi.advanceTimersByTimeAsync(TURN_STALL_TIMEOUT_MS / 2);
      await client.emit(assistantTextPartEvent());

      // The original deadline passes without firing…
      await vi.advanceTimersByTimeAsync(TURN_STALL_TIMEOUT_MS - 1_000);
      expect(client.abort).not.toHaveBeenCalled();

      // …but a full quiet window after the last activity does fire.
      await vi.advanceTimersByTimeAsync(1_000);
      await vi.waitFor(() => {
        expect(client.abort).toHaveBeenCalledTimes(1);
      });
    } finally {
      harness.dispose();
    }
  });

  it('never fires while a tracked execute tool is running', async () => {
    const { client, harness } = createHarness();

    try {
      await connectHarness(harness, client);
      vi.useFakeTimers();
      await startTask(client, harness);

      await client.emit({
        type: 'message.part.updated',
        properties: {
          info: { id: 'msg_a1', role: 'assistant' },
          part: {
            id: 'prt_bash_1',
            sessionID: 'ses_1',
            messageID: 'msg_a1',
            type: 'tool',
            tool: 'bash',
            callID: 'call_bash_1',
            state: { status: 'running', input: { command: 'pnpm build' } },
          },
        },
      });

      // A long command emits no events while it runs; the in-memory tracker
      // defers the stall check without even a server round-trip.
      await vi.advanceTimersByTimeAsync(TURN_STALL_TIMEOUT_MS * 3);

      expect(client.abort).not.toHaveBeenCalled();
      expect(client.messages).not.toHaveBeenCalled();
    } finally {
      harness.dispose();
    }
  });

  it('defers to a server-side running tool part and recovers once it settles silently', async () => {
    const { client, harness } = createHarness();

    try {
      await connectHarness(harness, client);
      vi.useFakeTimers();
      await startTask(client, harness);

      // An MCP tool starts running and its part update is the last event to
      // arrive. MCP tools have no local tracker, so only the server-side
      // verification can tell this apart from a stalled stream.
      await client.emit({
        type: 'message.part.updated',
        properties: {
          info: { id: 'msg_a1', role: 'assistant' },
          part: mcpToolPart('running'),
        },
      });
      client.messages.mockResolvedValue([
        assistantMessageWithParts([mcpToolPart('running')]),
      ]);

      await vi.advanceTimersByTimeAsync(TURN_STALL_TIMEOUT_MS * 3);

      expect(client.abort).not.toHaveBeenCalled();
      expect(client.messages).toHaveBeenCalled();

      // The tool finishes but OpenCode then goes silent — the wedge
      // signature. The next verification finds no running tool and recovers.
      client.messages.mockResolvedValue([
        assistantMessageWithParts([mcpToolPart('completed')]),
      ]);
      await vi.advanceTimersByTimeAsync(TURN_STALL_TIMEOUT_MS);

      await vi.waitFor(() => {
        expect(client.abort).toHaveBeenCalledTimes(1);
      });
    } finally {
      harness.dispose();
    }
  });

  it('never recovers when verification cannot reach the server', async () => {
    const { client, harness, logger } = createHarness();

    try {
      await connectHarness(harness, client);
      vi.useFakeTimers();
      await startTask(client, harness);

      client.messages.mockRejectedValue(new Error('connection reset'));

      await vi.advanceTimersByTimeAsync(TURN_STALL_TIMEOUT_MS * 3);

      expect(client.abort).not.toHaveBeenCalled();
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('Could not verify'),
      );
    } finally {
      harness.dispose();
    }
  });

  it('never fires while a question awaits the user', async () => {
    const { client, harness } = createHarness();

    try {
      await connectHarness(harness, client);
      vi.useFakeTimers();
      await startTask(client, harness);

      await client.emit({
        type: 'message.part.updated',
        properties: {
          info: { id: 'msg_a1', role: 'assistant' },
          part: {
            id: 'prt_q1',
            sessionID: 'ses_1',
            messageID: 'msg_a1',
            type: 'tool',
            tool: 'question',
            callID: 'call_q1',
            state: {
              status: 'running',
              input: {
                questions: [
                  { id: 'q1', header: 'Choice', question: 'Which option?' },
                ],
              },
            },
          },
        },
      });
      expect(harness.getPendingUserInputRequests()).toHaveLength(1);

      // A pending question legitimately waits on the user indefinitely.
      await vi.advanceTimersByTimeAsync(TURN_STALL_TIMEOUT_MS * 3);

      expect(client.abort).not.toHaveBeenCalled();
      expect(client.messages).not.toHaveBeenCalled();
    } finally {
      harness.dispose();
    }
  });
});
