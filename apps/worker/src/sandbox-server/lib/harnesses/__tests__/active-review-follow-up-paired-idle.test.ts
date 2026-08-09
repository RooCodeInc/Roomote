/**
 * Paired-idle regression coverage for deferred run completion. OpenCode 1.17
 * emits `session.status(idle)` followed by a legacy `session.idle` for a
 * single turn boundary. When the status-sourced completion drains a queued
 * hidden follow-up (submitting a new prompt and re-arming `inFlight`), the
 * trailing `session.idle` must not re-enter turn completion: doing so emits a
 * second taskCompleted with an empty queue, which finalizes the run (onExit)
 * while the drained re-review turn is still running.
 */
import { TaskEventName, type TaskEvent } from '@roomote/types';

import { HarnessManager } from '../../harness-manager';
import type { OpenCodeServerClient } from '../opencode-server/client';
import { OpenCodeServerHarness } from '../opencode-server/harness';
import type {
  OpenCodeGlobalEvent,
  OpenCodeSessionMessage,
} from '../opencode-server/types';

vi.mock('../../../../monitoring/sentry', () => ({
  captureWorkerMessage: vi.fn(),
}));

const TEST_OPENCODE_MODEL = 'test-provider/main-model';
const RE_REVIEW_CLIENT_MESSAGE_ID = 'github-pr-synchronize:100:owner/repo:42';

class FakeOpenCodeServerClient {
  private eventHandler:
    | ((event: OpenCodeGlobalEvent) => void | Promise<void>)
    | undefined;

  health = vi.fn(async () => ({ healthy: true as const, version: 'test' }));
  createSession = vi.fn(
    async (_options?: { title?: string; signal?: AbortSignal }) => ({
      id: 'ses_1',
      title: 'test',
    }),
  );
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

function createFinalAssistantMessage(
  messageId: string,
  text: string,
): OpenCodeSessionMessage {
  return {
    info: {
      id: messageId,
      sessionID: 'ses_1',
      role: 'assistant',
      providerID: 'openrouter',
      modelID: 'openai/gpt-5.4',
      mode: 'build',
      time: { created: 0, completed: 1 },
      cost: 0.000123,
      tokens: {
        input: 5,
        output: 2,
        reasoning: 1,
        cache: { read: 3, write: 4 },
      },
    },
    parts: [
      {
        id: `${messageId}_part`,
        sessionID: 'ses_1',
        messageID: messageId,
        type: 'text',
        text,
      },
    ],
  };
}

/**
 * Finish a turn the way OpenCode 1.17 does live: `session.status` with
 * `status.type === 'idle'` followed by the paired legacy `session.idle`.
 */
async function completeTurnWithPairedIdle(
  client: FakeOpenCodeServerClient,
  messageId: string,
  text: string,
): Promise<void> {
  client.message.mockResolvedValueOnce(
    createFinalAssistantMessage(messageId, text),
  );
  await client.emit({
    type: 'message.part.updated',
    properties: {
      part: {
        id: `${messageId}_part`,
        sessionID: 'ses_1',
        messageID: messageId,
        type: 'text',
        text,
      },
      delta: text,
    },
  });
  await client.emit({
    type: 'message.updated',
    properties: {
      info: {
        id: messageId,
        sessionID: 'ses_1',
        role: 'assistant',
        time: { completed: 1 },
      },
    },
  });
  await client.emit({
    type: 'session.status',
    properties: { sessionID: 'ses_1', status: { type: 'idle' } },
  });
  await client.emit({
    type: 'session.idle',
    properties: { sessionID: 'ses_1' },
  });
}

function createFixture() {
  const client = new FakeOpenCodeServerClient();
  const harness = new OpenCodeServerHarness({
    client: client as unknown as OpenCodeServerClient,
    workspacePath: '/tmp/workspace',
    logger: createLogger(),
    model: TEST_OPENCODE_MODEL,
    eventStreamReadyTimeoutMs: 100,
  });

  const submittedPrompts: string[] = [];
  client.promptAsync.mockImplementation(async (options: unknown) => {
    const request = (options as { request?: { parts?: Array<unknown> } })
      .request;
    const firstPart = request?.parts?.[0] as { text?: string } | undefined;
    submittedPrompts.push(firstPart?.text ?? '');
  });

  const onExit = vi.fn();
  const onTaskUpdate = vi.fn();
  const manager = new HarnessManager({
    harness,
    keepaliveMs: 60_000,
    runId: 100,
    taskId: 'task-100',
    logger: { ...createLogger(), log: vi.fn() },
    callbacks: { onExit, onTaskUpdate },
  });

  const taskEvents: TaskEvent[] = [];
  harness.subscribe((event) => taskEvents.push(event));

  return {
    client,
    harness,
    manager,
    onExit,
    onTaskUpdate,
    submittedPrompts,
    taskEvents,
  };
}

describe('active PR review follow-up lifecycle (paired session.status idle + session.idle)', () => {
  it('defers run completion across the paired idle until the drained re-review turn has run', async () => {
    const fixture = createFixture();
    const {
      client,
      harness,
      manager,
      onExit,
      onTaskUpdate,
      submittedPrompts,
      taskEvents,
    } = fixture;

    try {
      await connectHarness(harness, client);
      manager.initializeWithoutPrompt();
      expect(
        manager.startNewTaskFromPrompt({
          prompt: 'Review PR owner/repo#42.',
          source: 'github',
        }),
      ).toBe(true);
      await vi.waitFor(() => {
        expect(client.promptAsync).toHaveBeenCalledTimes(1);
      });

      // The new turn's busy status arrives before the hidden follow-up.
      await client.emit({
        type: 'session.status',
        properties: { sessionID: 'ses_1', status: { type: 'busy' } },
      });

      expect(
        manager.sendFollowUpPrompt({
          prompt: 'Re-review the PR head after new commits.',
          source: 'github-pr-synchronize',
          clientMessageId: RE_REVIEW_CLIENT_MESSAGE_ID,
          visibleInTranscript: false,
        }),
      ).toBe(true);

      await vi.waitFor(() => {
        expect(harness.getQueuedMessageSnapshots?.() ?? []).toHaveLength(1);
      });

      // The review turn finishes with the follow-up still queued, using the
      // live paired idle sequence. Completion must stay deferred while the
      // drain starts the re-review turn.
      await completeTurnWithPairedIdle(
        client,
        'msg_1',
        'Initial review pass done.',
      );

      await vi.waitFor(() => {
        expect(client.promptAsync).toHaveBeenCalledTimes(2);
      });

      expect(onExit).not.toHaveBeenCalled();
      expect(manager.getStatus().phase).toBe('running');
      expect(submittedPrompts[1]).toBe(
        'Re-review the PR head after new commits.',
      );

      // Only once the re-review turn settles with an empty queue does the
      // run finalize.
      await client.emit({
        type: 'session.status',
        properties: { sessionID: 'ses_1', status: { type: 'busy' } },
      });
      await completeTurnWithPairedIdle(
        client,
        'msg_2',
        'Re-reviewed latest head.',
      );

      await vi.waitFor(() => {
        expect(onExit).toHaveBeenCalledTimes(1);
      });
      expect(
        taskEvents.filter(
          (event) => event.eventName === TaskEventName.TaskCompleted,
        ),
      ).toHaveLength(2);
      expect(
        onTaskUpdate.mock.calls.filter(
          ([update]) => update.status === 'completed',
        ),
      ).toHaveLength(1);
    } finally {
      manager.dispose();
      harness.dispose();
    }
  });
});
