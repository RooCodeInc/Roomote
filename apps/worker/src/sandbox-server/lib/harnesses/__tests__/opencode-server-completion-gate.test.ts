/**
 * Turn-end completion check: a flagged verdict reopens the turn once with a
 * hidden prompt; every other outcome completes the turn normally.
 */
import { TaskEventName, type TaskEvent } from '@roomote/types';

import { TaskCommandName } from '../../harness';
import type { OpenCodeServerClient } from '../opencode-server/client';
import { OpenCodeServerHarness } from '../opencode-server/harness';
import type {
  OpenCodeGlobalEvent,
  OpenCodeSessionMessage,
} from '../opencode-server/types';

const { mockCollectShippedDiff, mockRequestTaskCompletionCheck } = vi.hoisted(
  () => ({
    mockCollectShippedDiff: vi.fn(),
    mockRequestTaskCompletionCheck: vi.fn(),
  }),
);

vi.mock('../../../../monitoring/sentry', () => ({
  captureWorkerMessage: vi.fn(),
}));

vi.mock('../opencode-server/completion-gate', async (importOriginal) => ({
  ...(await importOriginal<
    typeof import('../opencode-server/completion-gate')
  >()),
  collectShippedDiff: mockCollectShippedDiff,
  requestTaskCompletionCheck: mockRequestTaskCompletionCheck,
}));

const GATE_ENV = {
  ROOMOTE_CLOUD_TOKEN: 'run-token',
  ROOMOTE_PLATFORM_API_URL: 'http://api.test',
  ROOMOTE_TASK_RUN_ID: '42',
  ROOMOTE_TASK_TYPE: 'standard',
  ROOMOTE_AUTOMATION_TASK: 'false',
};

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
        options.signal.addEventListener('abort', () => resolve(), {
          once: true,
        });
      });
    },
  );

  async emit(event: OpenCodeGlobalEvent): Promise<void> {
    await this.eventHandler?.(event);
  }
}

function finalMessage(messageId: string, text: string): OpenCodeSessionMessage {
  return {
    info: {
      id: messageId,
      sessionID: 'ses_1',
      role: 'assistant',
      providerID: 'openrouter',
      modelID: 'openai/gpt-5.4',
      mode: 'build',
      time: { created: 0, completed: 1 },
      cost: 0,
      tokens: {
        input: 1,
        output: 1,
        reasoning: 0,
        cache: { read: 0, write: 0 },
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

/** OpenCode 1.17 ends a turn with session.status(idle) then session.idle. */
async function completeTurn(
  client: FakeOpenCodeServerClient,
  messageId: string,
  text: string,
): Promise<void> {
  client.message.mockResolvedValueOnce(finalMessage(messageId, text));
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

async function startTask(commandEnv: Record<string, string> = GATE_ENV) {
  const client = new FakeOpenCodeServerClient();
  const harness = new OpenCodeServerHarness({
    client: client as unknown as OpenCodeServerClient,
    workspacePath: '/tmp/workspace',
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    commandEnv,
    model: 'test-provider/main-model',
    eventStreamReadyTimeoutMs: 100,
  });
  const events: TaskEvent[] = [];
  const prompts: string[] = [];
  const reports: string[] = [];

  harness.subscribe((event) => events.push(event));
  harness.subscribeRuntimeTurnCompleted((event) => reports.push(event.text));
  client.promptAsync.mockImplementation(async (options: unknown) => {
    const parts = (
      options as { request?: { parts?: Array<{ text?: string }> } }
    ).request?.parts;
    prompts.push(parts?.[0]?.text ?? '');
  });

  const connected = harness.connect();
  await vi.waitFor(() => expect(client.streamEvents).toHaveBeenCalled());
  await client.emit({ type: 'server.connected' });
  await connected;

  harness.sendCommand({
    commandName: TaskCommandName.StartNewTask,
    data: { text: 'Remove the guard.', visibleInTranscript: true },
  });
  await vi.waitFor(() => expect(prompts).toHaveLength(1));

  const completed = () =>
    events.filter((event) => event.eventName === TaskEventName.TaskCompleted);

  return { client, harness, prompts, completed, reports };
}

describe('OpenCode harness completion check', () => {
  beforeEach(() => {
    mockCollectShippedDiff.mockReset().mockResolvedValue({
      key: 'diff-1',
      diff: 'diff --git a/a.ts b/a.ts\n+change\n',
      diffStat: ' a.ts | 1 +',
      diffTruncated: false,
    });
    mockRequestTaskCompletionCheck
      .mockReset()
      .mockResolvedValue({ status: 'clear', flags: [] });
  });

  it('completes the turn when the check is clear', async () => {
    const { client, harness, prompts, completed } = await startTask();

    try {
      await completeTurn(client, 'msg_1', 'Removed the guard.');

      await vi.waitFor(() => expect(completed()).toHaveLength(1));
      expect(prompts).toHaveLength(1);
      expect(mockRequestTaskCompletionCheck).toHaveBeenCalledWith(
        GATE_ENV,
        expect.objectContaining({
          report: 'Removed the guard.',
          diffTruncated: false,
        }),
      );
    } finally {
      harness.dispose();
    }
  });

  it('reopens the turn once when flagged, then completes with both reports', async () => {
    mockRequestTaskCompletionCheck.mockResolvedValue({
      status: 'flagged',
      flags: [{ id: 'requestUnaddressed', probability: 0.93 }],
    });
    const { client, harness, prompts, completed, reports } = await startTask();

    try {
      await completeTurn(client, 'msg_1', 'Removed the guard.');

      await vi.waitFor(() => expect(prompts).toHaveLength(2));
      expect(prompts[1]).toContain(
        'Part of what was asked does not appear in the diff',
      );
      expect(completed()).toHaveLength(0);

      // The fix changes the diff, but the single reminder is spent.
      mockCollectShippedDiff.mockResolvedValue({
        key: 'diff-2',
        diff: 'diff --git a/a.ts b/a.ts\n+fixed\n',
        diffStat: ' a.ts | 1 +',
        diffTruncated: false,
      });
      await completeTurn(client, 'msg_2', 'Also removed the helper.');

      await vi.waitFor(() => expect(completed()).toHaveLength(1));
      expect(prompts).toHaveLength(2);
      expect(mockRequestTaskCompletionCheck).toHaveBeenCalledTimes(1);
      expect(reports).toEqual([
        'Removed the guard.\n\nAlso removed the helper.',
      ]);
    } finally {
      harness.dispose();
    }
  });

  it('does not re-check a diff it has already seen', async () => {
    const { client, harness, completed } = await startTask();

    try {
      await completeTurn(client, 'msg_1', 'Removed the guard.');
      await vi.waitFor(() => expect(completed()).toHaveLength(1));

      harness.sendCommand({
        commandName: TaskCommandName.SendMessage,
        data: { text: 'What did you change?', visibleInTranscript: true },
      });
      await completeTurn(client, 'msg_2', 'Only the guard.');

      await vi.waitFor(() => expect(completed()).toHaveLength(2));
      expect(mockRequestTaskCompletionCheck).toHaveBeenCalledTimes(1);
    } finally {
      harness.dispose();
    }
  });

  it('skips the check when nothing changed or the task is ineligible', async () => {
    mockCollectShippedDiff.mockResolvedValue(null);
    const unchanged = await startTask();

    try {
      await completeTurn(unchanged.client, 'msg_1', 'Nothing to change.');
      await vi.waitFor(() => expect(unchanged.completed()).toHaveLength(1));
    } finally {
      unchanged.harness.dispose();
    }

    const review = await startTask({
      ...GATE_ENV,
      ROOMOTE_TASK_TYPE: 'github_pr_review',
    });

    try {
      await completeTurn(review.client, 'msg_1', 'Reviewed.');
      await vi.waitFor(() => expect(review.completed()).toHaveLength(1));
    } finally {
      review.harness.dispose();
    }

    expect(mockRequestTaskCompletionCheck).not.toHaveBeenCalled();
  });
});
