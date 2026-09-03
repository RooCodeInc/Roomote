import fs from 'node:fs/promises';

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
const TURN_STALL_TIMEOUT_MS = 60_000;
const STEER_TEXT = 'Use this newer instruction instead.';
let harnessSequence = 0;

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
  const visualProofAttemptStatePath = `/tmp/roomote-visual-proof-stall-test-${process.pid}-${harnessSequence++}.json`;
  const harness = new OpenCodeServerHarness({
    client: client as unknown as OpenCodeServerClient,
    workspacePath: '/tmp/workspace',
    logger,
    model: TEST_OPENCODE_MODEL,
    eventStreamReadyTimeoutMs: 100,
    turnStallTimeoutMs: TURN_STALL_TIMEOUT_MS,
    visualProofAttemptStatePath,
  });

  return { client, harness, logger, visualProofAttemptStatePath };
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

describe('OpenCode turn stall watchdog', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('trusts native steering until verified whole-turn recovery replays it', async () => {
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
      // Re-baseline the stall clock after startTask's waitFor advances fake
      // time, then inject the steer so it remains pending for recovery.
      await client.emit(assistantTextPartEvent());
      await injectSteer(client, harness);

      // Native steering gets substantially longer than the removed 5-second
      // pickup window without any interrupt.
      await vi.advanceTimersByTimeAsync(TURN_STALL_TIMEOUT_MS / 4);
      expect(client.abort).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(TURN_STALL_TIMEOUT_MS);

      await vi.waitFor(() => {
        expect(client.abort).toHaveBeenCalledTimes(1);
        expect(client.promptAsync).toHaveBeenCalledTimes(3);
      });
      expect(client.promptAsync.mock.calls[2]?.[0]).toMatchObject({
        sessionId: 'ses_1',
        request: {
          parts: [{ type: 'text', text: STEER_TEXT }],
        },
      });

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

  it('queues a steer that arrives while whole-turn recovery is aborting', async () => {
    const { client, harness } = createHarness();
    const taskEvents: TaskEvent[] = [];
    let resolveAbort: ((value: boolean) => void) | undefined;
    client.abort.mockImplementationOnce(
      async () =>
        new Promise<boolean>((resolve) => {
          resolveAbort = resolve;
        }),
    );
    harness.subscribe((event) => taskEvents.push(event));

    try {
      await connectHarness(harness, client);
      vi.useFakeTimers();
      await startTask(client, harness);
      await client.emit(assistantTextPartEvent());

      await vi.advanceTimersByTimeAsync(TURN_STALL_TIMEOUT_MS);
      await vi.waitFor(() => {
        expect(client.abort).toHaveBeenCalledTimes(1);
      });

      harness.sendCommand({
        commandName: TaskCommandName.SendMessage,
        data: {
          text: STEER_TEXT,
          autoSteerWhenQueued: true,
          visibleInTranscript: true,
        },
      });
      await vi.waitFor(() => {
        expect(harness.getQueuedMessages()).toHaveLength(1);
      });
      expect(client.promptAsync).toHaveBeenCalledTimes(1);

      resolveAbort?.(true);
      await vi.waitFor(() => {
        expect(client.promptAsync).toHaveBeenCalledTimes(2);
      });
      expect(client.promptAsync.mock.calls[1]?.[0]).toMatchObject({
        sessionId: 'ses_1',
        request: {
          parts: [{ type: 'text', text: STEER_TEXT }],
        },
      });
      expect(
        taskEvents.some(
          (event) => event.eventName === TaskEventName.TaskAborted,
        ),
      ).toBe(false);
    } finally {
      harness.dispose();
    }
  });

  it('does not start stall recovery while native steer submission is pending', async () => {
    const { client, harness } = createHarness();
    let resolveSteer: ((value: undefined) => void) | undefined;

    try {
      await connectHarness(harness, client);
      vi.useFakeTimers();
      await startTask(client, harness);
      await client.emit(assistantTextPartEvent());
      client.promptAsync.mockImplementationOnce(
        async () =>
          new Promise<undefined>((resolve) => {
            resolveSteer = resolve;
          }),
      );

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

      await vi.advanceTimersByTimeAsync(TURN_STALL_TIMEOUT_MS * 2);
      expect(client.abort).not.toHaveBeenCalled();

      resolveSteer?.(undefined);
      await vi.waitFor(() => {
        expect(harness.getQueuedMessages()).toHaveLength(0);
      });
      await vi.advanceTimersByTimeAsync(TURN_STALL_TIMEOUT_MS);

      await vi.waitFor(() => {
        expect(client.abort).toHaveBeenCalledTimes(1);
        expect(client.promptAsync).toHaveBeenCalledTimes(3);
      });
    } finally {
      harness.dispose();
    }
  });

  it('aborts a wedged turn, surfaces a retryable error, and ends the task', async () => {
    const { client, harness, visualProofAttemptStatePath } = createHarness();
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
      await fs.writeFile(
        visualProofAttemptStatePath,
        JSON.stringify({ attemptId: 'wedged-attempt' }),
      );
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
      await expect(
        fs.readFile(visualProofAttemptStatePath, 'utf8'),
      ).rejects.toMatchObject({ code: 'ENOENT' });

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
