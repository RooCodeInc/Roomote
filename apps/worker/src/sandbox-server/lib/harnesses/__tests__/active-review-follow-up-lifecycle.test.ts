/**
 * Lifecycle regression coverage for commit-triggered PR re-review follow-ups
 * (the hidden prompts activePrReviewFollowUpJob sends into an active review
 * run): a deliverable hidden follow-up must keep the task alive until the
 * re-review turn has run, and repeated follow-ups for the same run must
 * replace the queued prompt instead of stacking duplicate re-review turns.
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

async function completeTurn(
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
  const manager = new HarnessManager({
    harness,
    keepaliveMs: 60_000,
    runId: 100,
    taskId: 'task-100',
    logger: { ...createLogger(), log: vi.fn() },
    callbacks: { onExit },
  });

  const taskEvents: TaskEvent[] = [];
  harness.subscribe((event) => taskEvents.push(event));

  return { client, harness, manager, onExit, submittedPrompts, taskEvents };
}

describe('active PR review follow-up lifecycle', () => {
  it('defers run completion until the queued hidden re-review turn has run', async () => {
    const fixture = createFixture();
    const { client, harness, manager, onExit, submittedPrompts, taskEvents } =
      fixture;

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

      // The bullmq job delivers the hidden follow-up while the review turn
      // is in flight — the exact sendPrompt shape from
      // apps/bullmq/src/jobs/active-pr-review-follow-up.ts.
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

      // A second synchronize burst for the same run replaces the queued
      // prompt instead of stacking a duplicate re-review turn.
      expect(
        manager.sendFollowUpPrompt({
          prompt: 'Re-review the PR head after even newer commits.',
          source: 'github-pr-synchronize',
          clientMessageId: RE_REVIEW_CLIENT_MESSAGE_ID,
          visibleInTranscript: false,
        }),
      ).toBe(true);

      await vi.waitFor(() => {
        const queued = harness.getQueuedMessageSnapshots?.() ?? [];
        expect(queued).toHaveLength(1);
        expect(queued[0]?.text).toBe(
          'Re-review the PR head after even newer commits.',
        );
      });

      // The review turn finishes with the follow-up still queued: completion
      // must be deferred, and the drain starts the re-review turn.
      await completeTurn(client, 'msg_1', 'Initial review pass done.');

      await vi.waitFor(() => {
        expect(client.promptAsync).toHaveBeenCalledTimes(2);
      });

      expect(onExit).not.toHaveBeenCalled();
      expect(manager.getStatus().phase).toBe('running');
      expect(submittedPrompts[1]).toBe(
        'Re-review the PR head after even newer commits.',
      );

      // Only once the re-review turn settles with an empty queue does the
      // run finalize.
      await completeTurn(client, 'msg_2', 'Re-reviewed latest head.');

      await vi.waitFor(() => {
        expect(onExit).toHaveBeenCalledTimes(1);
      });
      expect(
        taskEvents.filter(
          (event) => event.eventName === TaskEventName.TaskCompleted,
        ),
      ).toHaveLength(2);
    } finally {
      manager.dispose();
      harness.dispose();
    }
  });
});
