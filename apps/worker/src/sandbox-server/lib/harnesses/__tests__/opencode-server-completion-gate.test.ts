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
  ROOMOTE_COMPLETION_GATE: 'true',
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
      fingerprint: 'code-1',
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
        'Part of what was asked does not appear to be done',
      );
      expect(completed()).toHaveLength(0);

      // The fix changes the diff, but the single reminder is spent.
      mockCollectShippedDiff.mockResolvedValue({
        key: 'diff-2',
        fingerprint: 'code-2',
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

  it('re-checks an unchanged diff only when a new visible request arrived', async () => {
    const { client, harness, prompts, completed } = await startTask();

    try {
      await completeTurn(client, 'msg_1', 'Removed the guard.');
      await vi.waitFor(() => expect(completed()).toHaveLength(1));

      harness.sendCommand({
        commandName: TaskCommandName.SendMessage,
        data: { text: 'Internal follow-up.', visibleInTranscript: false },
      });
      await vi.waitFor(() => expect(prompts).toHaveLength(2));
      await completeTurn(client, 'msg_2', 'Nothing further.');

      await vi.waitFor(() => expect(completed()).toHaveLength(2));
      expect(mockRequestTaskCompletionCheck).toHaveBeenCalledTimes(1);

      // The agent may only claim to have acted on a new request, leaving the
      // diff as it was; that turn still has to be checked.
      harness.sendCommand({
        commandName: TaskCommandName.SendMessage,
        data: { text: 'Also remove the helper.', visibleInTranscript: true },
      });
      await vi.waitFor(() => expect(prompts).toHaveLength(3));
      await completeTurn(client, 'msg_3', 'Removed the helper too.');

      await vi.waitFor(() => expect(completed()).toHaveLength(3));
      expect(mockRequestTaskCompletionCheck).toHaveBeenCalledTimes(2);
    } finally {
      harness.dispose();
    }
  });

  it('checks a request that arrived while the previous check was still running', async () => {
    let releaseCheck: (() => void) | undefined;
    mockRequestTaskCompletionCheck.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseCheck = () => resolve({ status: 'clear', flags: [] });
        }),
    );
    const { client, harness, prompts, completed } = await startTask();

    try {
      const firstTurn = completeTurn(client, 'msg_1', 'Removed the guard.');
      await vi.waitFor(() => expect(releaseCheck).toBeDefined());

      // Queues behind the in-flight turn; the older check then records what
      // it saw, which must not cover this request.
      harness.sendCommand({
        commandName: TaskCommandName.SendMessage,
        data: { text: 'Also remove the helper.', visibleInTranscript: true },
      });
      releaseCheck?.();
      await firstTurn;
      await vi.waitFor(() => expect(prompts).toHaveLength(2));

      await completeTurn(client, 'msg_2', 'Removed the helper too.');

      await vi.waitFor(() => expect(completed()).toHaveLength(2));
      expect(mockRequestTaskCompletionCheck).toHaveBeenCalledTimes(2);
    } finally {
      harness.dispose();
    }
  });

  it('judges a turn against its own request when a follow-up lands mid-check', async () => {
    let releaseCheck: (() => void) | undefined;
    mockRequestTaskCompletionCheck.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseCheck = () =>
            resolve({
              status: 'flagged',
              flags: [{ id: 'reportOverclaims', probability: 0.9 }],
            });
        }),
    );
    const { client, harness, prompts, completed } = await startTask();

    try {
      const firstTurn = completeTurn(client, 'msg_1', 'Removed the guard.');
      await vi.waitFor(() => expect(releaseCheck).toBeDefined());

      // A steerable follow-up must wait for the closing turn rather than be
      // injected into it or spend that turn's reminder.
      harness.sendCommand({
        commandName: TaskCommandName.SendMessage,
        data: {
          text: 'Also remove the helper.',
          visibleInTranscript: true,
          autoSteerWhenQueued: true,
        },
      });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(prompts).toHaveLength(1);

      releaseCheck?.();
      await firstTurn;

      // The flagged first turn is reopened, then the follow-up is delivered.
      await vi.waitFor(() => expect(prompts).toHaveLength(3));
      expect(prompts[1]).toContain('Your report describes a code change');
      expect(prompts[2]).toBe('Also remove the helper.');
      expect(completed()).toHaveLength(0);

      // The follow-up's own turn still gets a check and a reminder of its own.
      mockRequestTaskCompletionCheck.mockResolvedValueOnce({
        status: 'flagged',
        flags: [{ id: 'requestUnaddressed', probability: 0.92 }],
      });
      await completeTurn(client, 'msg_2', 'Removed the helper too.');

      await vi.waitFor(() => expect(prompts).toHaveLength(4));
      expect(prompts[3]).toContain('Part of what was asked');
    } finally {
      harness.dispose();
    }
  });

  it('holds a follow-up steered in before the check has even started', async () => {
    const { client, harness, prompts, completed } = await startTask();
    let releaseFinalMessage: (() => void) | undefined;
    const order: string[] = [];

    mockRequestTaskCompletionCheck.mockImplementationOnce(async () => {
      order.push('check');
      return { status: 'clear', flags: [] };
    });
    client.promptAsync.mockImplementation(async (options: unknown) => {
      const parts = (
        options as { request?: { parts?: Array<{ text?: string }> } }
      ).request?.parts;
      prompts.push(parts?.[0]?.text ?? '');
      order.push('prompt');
    });
    // The turn is closing, but still reading its last message from OpenCode.
    let delayed = false;
    client.messages.mockImplementation(() => {
      const messages = [finalMessage('msg_1', 'Removed the guard.')];

      if (delayed) {
        return Promise.resolve(messages);
      }

      delayed = true;
      return new Promise((resolve) => {
        releaseFinalMessage = () => resolve(messages);
      });
    });

    try {
      const closing = client.emit({
        type: 'session.idle',
        properties: { sessionID: 'ses_1' },
      });
      await vi.waitFor(() => expect(releaseFinalMessage).toBeDefined());

      harness.sendCommand({
        commandName: TaskCommandName.SendMessage,
        data: {
          text: 'Also remove the helper.',
          visibleInTranscript: true,
          autoSteerWhenQueued: true,
        },
      });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(prompts).toHaveLength(1);

      releaseFinalMessage?.();
      await closing;

      await vi.waitFor(() => expect(prompts).toHaveLength(2));
      expect(order).toEqual(['check', 'prompt']);
      expect(completed()).toHaveLength(1);
    } finally {
      harness.dispose();
    }
  });

  it('sends the shell commands it observed as validation evidence', async () => {
    const { client, harness, completed } = await startTask();
    const emitBash = (
      callId: string,
      command: string,
      state: Record<string, unknown>,
      sessionID = 'ses_1',
    ) =>
      client.emit({
        type: 'message.part.updated',
        properties: {
          part: {
            id: `prt_${callId}`,
            sessionID,
            messageID: 'msg_1',
            type: 'tool',
            tool: 'bash',
            callID: callId,
            state: { input: { command }, ...state },
          },
        },
      });

    try {
      await emitBash('call_1', 'pnpm vitest run src/guard.test.ts', {
        status: 'completed',
        output: 'Tests  1 failed | 11 passed (12)',
        metadata: { exitCode: 1 },
      });
      await emitBash('call_2', 'pnpm check-types', {
        status: 'completed',
        output: 'Tasks: 27 successful, 27 total',
        metadata: { exitCode: 0 },
      });
      await completeTurn(client, 'msg_1', 'Removed the guard. Tests pass.');

      await vi.waitFor(() => expect(completed()).toHaveLength(1));
      expect(mockRequestTaskCompletionCheck.mock.calls[0]![1].commands).toEqual(
        [
          {
            command: 'pnpm vitest run src/guard.test.ts',
            exitCode: 1,
            outputTail: 'Tests  1 failed | 11 passed (12)',
            ranBeforeLaterEdit: false,
          },
          {
            command: 'pnpm check-types',
            exitCode: 0,
            outputTail: 'Tasks: 27 successful, 27 total',
            ranBeforeLaterEdit: false,
          },
        ],
      );
    } finally {
      harness.dispose();
    }
  });

  it("reads the exit code the way OpenCode's shell tool reports it", async () => {
    const { client, harness, completed } = await startTask();

    try {
      await client.emit({
        type: 'message.part.updated',
        properties: {
          part: {
            id: 'prt_call_1',
            sessionID: 'ses_1',
            messageID: 'msg_1',
            type: 'tool',
            tool: 'bash',
            callID: 'call_1',
            state: {
              status: 'completed',
              input: { command: 'pnpm vitest run' },
              output: 'Tests  1 failed | 11 passed (12)',
              // OpenCode 1.18 shell tool metadata: `exit`, not `exitCode`.
              metadata: { exit: 1, truncated: false },
            },
          },
        },
      });
      await completeTurn(client, 'msg_1', 'Removed the guard. Tests pass.');

      await vi.waitFor(() => expect(completed()).toHaveLength(1));
      expect(
        mockRequestTaskCompletionCheck.mock.calls[0]![1].commands[0],
      ).toMatchObject({ command: 'pnpm vitest run', exitCode: 1 });
    } finally {
      harness.dispose();
    }
  });

  it('marks a run stale when the code changed after it, however it was changed', async () => {
    const { client, harness, completed } = await startTask();
    const diffAt = (code: string) => ({
      key: `diff-${code}`,
      fingerprint: code,
      diff: 'diff --git a/a.ts b/a.ts\n+change\n',
      diffStat: ' a.ts | 1 +',
      diffTruncated: false,
    });
    const runCommand = async (
      callId: string,
      command: string,
      code: string,
    ) => {
      // What the workspace holds once this command has finished.
      mockCollectShippedDiff.mockResolvedValueOnce(diffAt(code));
      await client.emit({
        type: 'message.part.updated',
        properties: {
          part: {
            id: `prt_${callId}`,
            sessionID: 'ses_1',
            messageID: 'msg_1',
            type: 'tool',
            tool: 'bash',
            callID: callId,
            state: {
              status: 'completed',
              input: { command },
              output: 'ok',
              metadata: { exitCode: 0 },
            },
          },
        },
      });
    };

    try {
      await runCommand('call_1', 'pnpm vitest run', 'code-1');
      // No pattern would recognize this as an edit; the fingerprint does.
      await runCommand(
        'call_2',
        "python3 - <<'EOF'\nopen('src/guard.ts','w').write(new_source)\nEOF",
        'code-2',
      );
      await runCommand('call_3', 'pnpm check-types', 'code-2');
      // A formatter rewrites files without changing the fingerprint.
      await runCommand('call_4', 'pnpm format', 'code-2');
      mockCollectShippedDiff.mockResolvedValue(diffAt('code-2'));
      await completeTurn(client, 'msg_1', 'Removed the guard. Tests pass.');

      await vi.waitFor(() => expect(completed()).toHaveLength(1));
      expect(
        mockRequestTaskCompletionCheck.mock.calls[0]![1].commands.map(
          (entry: { command: string; ranBeforeLaterEdit: boolean }) => [
            entry.command.split('\n')[0],
            entry.ranBeforeLaterEdit,
          ],
        ),
      ).toEqual([
        ['pnpm vitest run', true],
        ["python3 - <<'EOF'", false],
        ['pnpm check-types', false],
        ['pnpm format', false],
      ]);
    } finally {
      harness.dispose();
    }
  });

  it('does not let an earlier turn vouch for code changed since', async () => {
    const { client, harness, prompts, completed } = await startTask();
    const runTests = (callId: string) =>
      client.emit({
        type: 'message.part.updated',
        properties: {
          part: {
            id: `prt_${callId}`,
            sessionID: 'ses_1',
            messageID: 'msg_1',
            type: 'tool',
            tool: 'bash',
            callID: callId,
            state: {
              status: 'completed',
              input: { command: 'pnpm vitest run' },
              output: 'Tests  12 passed (12)',
              metadata: { exitCode: 0 },
            },
          },
        },
      });
    const followUp = async (text: string, promptCount: number) => {
      harness.sendCommand({
        commandName: TaskCommandName.SendMessage,
        data: { text, visibleInTranscript: true },
      });
      await vi.waitFor(() => expect(prompts).toHaveLength(promptCount));
    };
    const sentCommands = (call: number) =>
      mockRequestTaskCompletionCheck.mock.calls[call]![1].commands;

    try {
      await runTests('call_1');
      await completeTurn(client, 'msg_1', 'Removed the guard. Tests pass.');
      await vi.waitFor(() => expect(completed()).toHaveLength(1));
      expect(sentCommands(0)).toEqual([
        expect.objectContaining({ ranBeforeLaterEdit: false }),
      ]);

      // Nothing changed since the tests ran, so that run still stands.
      await followUp('Is it pushed?', 2);
      await completeTurn(client, 'msg_2', 'Yes, pushed. Tests pass.');
      await vi.waitFor(() => expect(completed()).toHaveLength(2));
      expect(sentCommands(1)).toEqual([
        expect.objectContaining({ ranBeforeLaterEdit: false }),
      ]);

      // More code changed and nothing was run: "tests pass" has no support.
      mockCollectShippedDiff.mockResolvedValue({
        key: 'diff-2',
        fingerprint: 'code-2',
        diff: 'diff --git a/a.ts b/a.ts\n+more\n',
        diffStat: ' a.ts | 2 +',
        diffTruncated: false,
      });
      await followUp('Also remove the helper.', 3);
      await completeTurn(client, 'msg_3', 'Removed the helper. Tests pass.');
      await vi.waitFor(() => expect(completed()).toHaveLength(3));
      expect(sentCommands(2)).toEqual([
        expect.objectContaining({
          command: 'pnpm vitest run',
          ranBeforeLaterEdit: true,
        }),
      ]);
    } finally {
      harness.dispose();
    }
  });

  it('does not submit a held follow-up after the task was cancelled', async () => {
    let releaseCheck: (() => void) | undefined;
    mockRequestTaskCompletionCheck.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseCheck = () => resolve({ status: 'clear', flags: [] });
        }),
    );
    const { client, harness, prompts } = await startTask();

    try {
      const firstTurn = completeTurn(client, 'msg_1', 'Removed the guard.');
      await vi.waitFor(() => expect(releaseCheck).toBeDefined());

      harness.sendCommand({
        commandName: TaskCommandName.SendMessage,
        data: { text: 'Also remove the helper.', visibleInTranscript: true },
      });
      harness.sendCommand({ commandName: TaskCommandName.CancelTask });
      releaseCheck?.();
      await firstTurn;
      await new Promise((resolve) => setTimeout(resolve, 20));

      // Reviving the task here would undo the cancel the user just asked for.
      expect(prompts).toEqual(['Remove the guard.']);
    } finally {
      harness.dispose();
    }
  });

  it('drops a verdict that arrives after the task was cancelled', async () => {
    let releaseCheck: (() => void) | undefined;
    mockRequestTaskCompletionCheck.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseCheck = () =>
            resolve({
              status: 'flagged',
              flags: [{ id: 'leftoverArtifacts', probability: 0.95 }],
            });
        }),
    );
    const { client, harness, prompts } = await startTask();

    try {
      const firstTurn = completeTurn(client, 'msg_1', 'Removed the guard.');
      await vi.waitFor(() => expect(releaseCheck).toBeDefined());

      harness.sendCommand({ commandName: TaskCommandName.CancelTask });
      releaseCheck?.();
      await firstTurn;
      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(prompts).toHaveLength(1);
    } finally {
      harness.dispose();
    }
  });

  it('holds a report to a person once when flagged, then lets the retry through', async () => {
    mockRequestTaskCompletionCheck.mockResolvedValue({
      status: 'flagged',
      flags: [{ id: 'reportOverclaims', probability: 0.9 }],
    });
    const { harness } = await startTask();

    try {
      const first = await harness.checkCompletionBeforeTool({
        tool: 'roomote_report_to_parent_session',
        args: { text: 'Removed the guard and added a retry helper.' },
      });

      expect(first.allowed).toBe(false);
      expect(first.reason).toContain('before sending it');
      expect(first.reason).toContain(
        'Your report describes a code change that the diff does not contain.',
      );
      // The report under check is the tool's own text.
      expect(mockRequestTaskCompletionCheck.mock.calls[0]![1].report).toBe(
        'Removed the guard and added a retry helper.',
      );

      // Same work: one hold only, and no second request to the platform.
      const second = await harness.checkCompletionBeforeTool({
        tool: 'roomote_report_to_parent_session',
        args: { text: 'Removed the guard and added a retry helper.' },
      });

      expect(second).toEqual({ allowed: true });
      expect(mockRequestTaskCompletionCheck).toHaveBeenCalledTimes(1);
    } finally {
      harness.dispose();
    }
  });

  it('checks before a push against the latest message, and does not re-check the same work at turn end', async () => {
    const { client, harness, prompts, completed } = await startTask();

    try {
      // A finalized parent message is the closest thing to a report so far.
      client.message.mockResolvedValueOnce(
        finalMessage('msg_0', 'Tests pass; pushing now.'),
      );
      await client.emit({
        type: 'message.updated',
        properties: {
          info: {
            id: 'msg_0',
            sessionID: 'ses_1',
            role: 'assistant',
            time: { completed: 1 },
          },
        },
      });

      await expect(
        harness.checkCompletionBeforeTool({
          tool: 'bash',
          args: { command: 'git push origin HEAD' },
        }),
      ).resolves.toEqual({ allowed: true });
      expect(mockRequestTaskCompletionCheck).toHaveBeenCalledTimes(1);
      expect(mockRequestTaskCompletionCheck.mock.calls[0]![1].report).toBe(
        'Tests pass; pushing now.',
      );

      await completeTurn(client, 'msg_1', 'Pushed. Done.');
      await vi.waitFor(() => expect(completed()).toHaveLength(1));
      // The diff has not changed since the pre-push check.
      expect(mockRequestTaskCompletionCheck).toHaveBeenCalledTimes(1);
      expect(prompts).toHaveLength(1);
    } finally {
      harness.dispose();
    }
  });

  it('allows tool calls that are neither a report nor shipping, and everything when ineligible', async () => {
    const { harness } = await startTask();
    const { ROOMOTE_COMPLETION_GATE: _gate, ...withoutGate } = GATE_ENV;
    const off = await startTask(withoutGate);

    try {
      await expect(
        harness.checkCompletionBeforeTool({
          tool: 'bash',
          args: { command: 'pnpm vitest run' },
        }),
      ).resolves.toEqual({ allowed: true });
      await expect(
        off.harness.checkCompletionBeforeTool({
          tool: 'bash',
          args: { command: 'git push' },
        }),
      ).resolves.toEqual({ allowed: true });
      expect(mockRequestTaskCompletionCheck).not.toHaveBeenCalled();
    } finally {
      harness.dispose();
      off.harness.dispose();
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
    const { ROOMOTE_COMPLETION_GATE: _gate, ...withoutJudgmentModel } =
      GATE_ENV;
    const noJudgmentModel = await startTask(withoutJudgmentModel);

    try {
      await completeTurn(noJudgmentModel.client, 'msg_1', 'Done.');
      await vi.waitFor(() =>
        expect(noJudgmentModel.completed()).toHaveLength(1),
      );
    } finally {
      noJudgmentModel.harness.dispose();
    }

    try {
      await completeTurn(review.client, 'msg_1', 'Reviewed.');
      await vi.waitFor(() => expect(review.completed()).toHaveLength(1));
    } finally {
      review.harness.dispose();
    }

    expect(mockRequestTaskCompletionCheck).not.toHaveBeenCalled();
  });
});
