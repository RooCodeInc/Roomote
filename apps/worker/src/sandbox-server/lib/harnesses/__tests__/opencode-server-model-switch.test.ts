import {
  MODEL_SWITCH_NOTICE_PAYLOAD_KEY,
  asRecord,
  type AcpPersistedEnvelope,
} from '@roomote/types';

import { TaskCommandName } from '../../harness';
import type { HarnessCommandError } from '../../harness';
import type { OpenCodeServerClient } from '../opencode-server/client';
import { OpenCodeServerHarness } from '../opencode-server/harness';
import type {
  OpenCodeGlobalEvent,
  OpenCodeSessionMessage,
} from '../opencode-server/types';

const LAUNCH_MODEL = 'openrouter/anthropic/claude-opus-5';
const FALLBACK_MODEL = 'anthropic/claude-opus-5';
const UNAVAILABLE_MODEL = 'openai/gpt-5.6-terra';

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
    await this.eventHandler?.(event);
  }
}

function createLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function createHarness(
  options: {
    model?: string;
    switchableModels?: string[];
    architectModelIsPinned?: boolean;
    onModelSwitched?: (model: string) => void;
  } = {},
) {
  const client = new FakeOpenCodeServerClient();
  const harness = new OpenCodeServerHarness({
    client: client as unknown as OpenCodeServerClient,
    workspacePath: '/tmp/workspace',
    logger: createLogger(),
    model: options.model ?? LAUNCH_MODEL,
    switchableModels: options.switchableModels ?? [
      LAUNCH_MODEL,
      FALLBACK_MODEL,
    ],
    architectModelIsPinned: options.architectModelIsPinned,
    onModelSwitched: options.onModelSwitched,
    eventStreamReadyTimeoutMs: 100,
  });

  return { client, harness };
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

function promptedModel(
  client: FakeOpenCodeServerClient,
  callIndex: number,
): { providerID?: string; modelID?: string } | undefined {
  const request = asRecord(
    (client.promptAsync.mock.calls[callIndex]?.[0] as { request?: unknown })
      ?.request,
  );

  return asRecord(request?.model) as
    | { providerID?: string; modelID?: string }
    | undefined;
}

/**
 * Loading the planning workflow skill moves later prompts onto the architect
 * agent, whose model normally comes from the generated config.
 */
async function enterPlanningWorkflow(
  client: FakeOpenCodeServerClient,
  partSuffix = 'plan',
): Promise<void> {
  await client.emit({
    type: 'message.part.updated',
    properties: {
      part: {
        id: `skill_part_${partSuffix}`,
        sessionID: 'ses_1',
        messageID: `msg_${partSuffix}`,
        type: 'tool',
        callID: `skill_call_${partSuffix}`,
        tool: 'skill',
        state: {
          status: 'completed',
          input: { name: 'plan-repo-implementation' },
          title: 'Load skill',
        },
      },
    },
  });
  await client.emit({
    type: 'session.idle',
    properties: { sessionID: 'ses_1' },
  });
}

async function startTask(
  harness: OpenCodeServerHarness,
  client: FakeOpenCodeServerClient,
  text = 'Do the thing.',
): Promise<void> {
  expect(
    harness.sendCommand({
      commandName: TaskCommandName.StartNewTask,
      data: { text, visibleInTranscript: true },
    }),
  ).toBe(true);

  await vi.waitFor(() => {
    expect(client.promptAsync).toHaveBeenCalled();
  });
}

describe('OpenCodeServerHarness model switching', () => {
  it('reports launch model state before any switch', async () => {
    const { client, harness } = createHarness();

    try {
      await connectHarness(harness, client);

      expect(harness.getActiveModel()).toBe(LAUNCH_MODEL);
      expect(harness.getLaunchModel()).toBe(LAUNCH_MODEL);
      expect(harness.getSwitchableModels()).toEqual([
        LAUNCH_MODEL,
        FALLBACK_MODEL,
      ]);
    } finally {
      harness.dispose();
    }
  });

  it('applies a switch to the next prompt without touching the in-flight turn', async () => {
    const { client, harness } = createHarness();

    try {
      await connectHarness(harness, client);
      await startTask(harness, client);

      expect(promptedModel(client, 0)).toEqual({
        providerID: 'openrouter',
        modelID: 'anthropic/claude-opus-5',
      });

      expect(
        harness.sendCommand({
          commandName: TaskCommandName.SwitchModel,
          data: { model: FALLBACK_MODEL, reason: 'user' },
        }),
      ).toBe(true);

      await vi.waitFor(() => {
        expect(harness.getActiveModel()).toBe(FALLBACK_MODEL);
      });

      // The switch must not interrupt the running turn.
      expect(client.abort).not.toHaveBeenCalled();
      expect(client.promptAsync).toHaveBeenCalledTimes(1);

      await client.emit({
        type: 'session.idle',
        properties: { sessionID: 'ses_1' },
      });

      expect(
        harness.sendCommand({
          commandName: TaskCommandName.SendMessage,
          data: { text: 'Continue.', visibleInTranscript: true },
        }),
      ).toBe(true);

      await vi.waitFor(() => {
        expect(client.promptAsync).toHaveBeenCalledTimes(2);
      });

      expect(promptedModel(client, 1)).toEqual({
        providerID: 'anthropic',
        modelID: 'claude-opus-5',
      });
      expect(harness.getLaunchModel()).toBe(LAUNCH_MODEL);
    } finally {
      harness.dispose();
    }
  });

  it('records the switch in the transcript with a structured notice', async () => {
    const { client, harness } = createHarness();
    const persisted: AcpPersistedEnvelope[] = [];

    harness.subscribeRuntimePersistedEnvelope((envelope) =>
      persisted.push(envelope),
    );

    try {
      await connectHarness(harness, client);
      await startTask(harness, client);

      harness.sendCommand({
        commandName: TaskCommandName.SwitchModel,
        data: { model: FALLBACK_MODEL, reason: 'user', userName: 'Ada' },
      });

      await vi.waitFor(() => {
        expect(
          persisted.some(
            (envelope) =>
              asRecord(envelope.payload)?.[MODEL_SWITCH_NOTICE_PAYLOAD_KEY] !==
              undefined,
          ),
        ).toBe(true);
      });

      const notice = persisted
        .map(
          (envelope) =>
            asRecord(envelope.payload)?.[MODEL_SWITCH_NOTICE_PAYLOAD_KEY],
        )
        .find((value) => value !== undefined);

      expect(notice).toMatchObject({
        reason: 'user',
        fromModel: LAUNCH_MODEL,
        toModel: FALLBACK_MODEL,
        requestedBy: 'Ada',
      });
    } finally {
      harness.dispose();
    }
  });

  it('rejects a model the generated config cannot resolve', async () => {
    const { client, harness } = createHarness();
    const commandErrors: HarnessCommandError[] = [];

    harness.subscribeCommandError((error) => commandErrors.push(error));

    try {
      await connectHarness(harness, client);
      await startTask(harness, client);

      harness.sendCommand({
        commandName: TaskCommandName.SwitchModel,
        data: { model: UNAVAILABLE_MODEL, reason: 'user' },
      });

      await vi.waitFor(() => {
        expect(commandErrors).toHaveLength(1);
      });

      expect(commandErrors[0]?.command.commandName).toBe(
        TaskCommandName.SwitchModel,
      );
      expect(harness.getActiveModel()).toBe(LAUNCH_MODEL);
    } finally {
      harness.dispose();
    }
  });

  it('rejects a model that is not in provider/model form', async () => {
    const { client, harness } = createHarness();
    const commandErrors: HarnessCommandError[] = [];

    harness.subscribeCommandError((error) => commandErrors.push(error));

    try {
      await connectHarness(harness, client);

      harness.sendCommand({
        commandName: TaskCommandName.SwitchModel,
        data: { model: 'not-qualified', reason: 'user' },
      });

      await vi.waitFor(() => {
        expect(commandErrors).toHaveLength(1);
      });

      expect(harness.getActiveModel()).toBe(LAUNCH_MODEL);
    } finally {
      harness.dispose();
    }
  });

  it('refuses every switch when no switchable set was advertised', async () => {
    const onModelSwitched = vi.fn();
    const { client, harness } = createHarness({
      switchableModels: [],
      onModelSwitched,
    });
    const commandErrors: HarnessCommandError[] = [];

    harness.subscribeCommandError((error) => commandErrors.push(error));

    try {
      await connectHarness(harness, client);
      await startTask(harness, client);

      harness.sendCommand({
        commandName: TaskCommandName.SwitchModel,
        data: { model: FALLBACK_MODEL, reason: 'user' },
      });

      await vi.waitFor(() => {
        expect(commandErrors).toHaveLength(1);
      });

      // Without a capability signal the switch could not be guaranteed to
      // survive a reconnect, so it must not be accepted at all.
      expect(harness.getActiveModel()).toBe(LAUNCH_MODEL);
      expect(onModelSwitched).not.toHaveBeenCalled();
    } finally {
      harness.dispose();
    }
  });

  it('sends the request-level model on architect prompts only after a switch', async () => {
    const { client, harness } = createHarness();

    try {
      await connectHarness(harness, client);
      await startTask(harness, client);

      await enterPlanningWorkflow(client);

      harness.sendCommand({
        commandName: TaskCommandName.SendMessage,
        data: { text: 'Keep planning.', visibleInTranscript: true },
      });

      await vi.waitFor(() => {
        expect(client.promptAsync).toHaveBeenCalledTimes(2);
      });

      const architectRequest = asRecord(
        (client.promptAsync.mock.calls[1]?.[0] as { request?: unknown })
          ?.request,
      );
      expect(architectRequest?.agent).toBe('architect');
      expect(architectRequest).not.toHaveProperty('model');

      harness.sendCommand({
        commandName: TaskCommandName.SwitchModel,
        data: { model: FALLBACK_MODEL, reason: 'failover' },
      });

      await vi.waitFor(() => {
        expect(harness.getActiveModel()).toBe(FALLBACK_MODEL);
      });

      await client.emit({
        type: 'session.idle',
        properties: { sessionID: 'ses_1' },
      });

      harness.sendCommand({
        commandName: TaskCommandName.SendMessage,
        data: { text: 'Continue planning.', visibleInTranscript: true },
      });

      await vi.waitFor(() => {
        expect(client.promptAsync).toHaveBeenCalledTimes(3);
      });

      const switchedArchitectRequest = asRecord(
        (client.promptAsync.mock.calls[2]?.[0] as { request?: unknown })
          ?.request,
      );
      expect(switchedArchitectRequest?.agent).toBe('architect');
      // With no pinned planning model the architect inherits the config's
      // top-level model, which is stale after a switch, so the request-level
      // model is the only way to move that turn.
      expect(promptedModel(client, 2)).toEqual({
        providerID: 'anthropic',
        modelID: 'claude-opus-5',
      });
    } finally {
      harness.dispose();
    }
  });

  it('reports an accepted switch so a reconnect can resume on it', async () => {
    const onModelSwitched = vi.fn();
    const { client, harness } = createHarness({ onModelSwitched });

    try {
      await connectHarness(harness, client);
      await startTask(harness, client);

      harness.sendCommand({
        commandName: TaskCommandName.SwitchModel,
        data: { model: FALLBACK_MODEL, reason: 'user' },
      });

      await vi.waitFor(() => {
        expect(onModelSwitched).toHaveBeenCalledWith(FALLBACK_MODEL);
      });

      // A reconnect respawns the harness from run-task, which otherwise only
      // knows the launch-time model override.
      expect(onModelSwitched).toHaveBeenCalledTimes(1);
    } finally {
      harness.dispose();
    }
  });

  it('does not report a rejected switch', async () => {
    const onModelSwitched = vi.fn();
    const { client, harness } = createHarness({ onModelSwitched });
    const commandErrors: HarnessCommandError[] = [];

    harness.subscribeCommandError((error) => commandErrors.push(error));

    try {
      await connectHarness(harness, client);
      await startTask(harness, client);

      harness.sendCommand({
        commandName: TaskCommandName.SwitchModel,
        data: { model: UNAVAILABLE_MODEL, reason: 'user' },
      });

      await vi.waitFor(() => {
        expect(commandErrors).toHaveLength(1);
      });

      expect(onModelSwitched).not.toHaveBeenCalled();
    } finally {
      harness.dispose();
    }
  });

  it('leaves a pinned planning model alone on an operator switch', async () => {
    const { client, harness } = createHarness({
      architectModelIsPinned: true,
    });

    try {
      await connectHarness(harness, client);
      await startTask(harness, client);
      await enterPlanningWorkflow(client);

      harness.sendCommand({
        commandName: TaskCommandName.SwitchModel,
        data: { model: FALLBACK_MODEL, reason: 'user' },
      });

      await vi.waitFor(() => {
        expect(harness.getActiveModel()).toBe(FALLBACK_MODEL);
      });

      harness.sendCommand({
        commandName: TaskCommandName.SendMessage,
        data: { text: 'Keep planning.', visibleInTranscript: true },
      });

      await vi.waitFor(() => {
        expect(client.promptAsync).toHaveBeenCalledTimes(2);
      });

      const architectRequest = asRecord(
        (client.promptAsync.mock.calls[1]?.[0] as { request?: unknown })
          ?.request,
      );
      expect(architectRequest?.agent).toBe('architect');
      // A configured planning model is a deliberate role choice; switching the
      // task's main model should not silently reassign it.
      expect(architectRequest).not.toHaveProperty('model');
    } finally {
      harness.dispose();
    }
  });

  it('overrides a pinned planning model on failover', async () => {
    const { client, harness } = createHarness({
      architectModelIsPinned: true,
    });

    try {
      await connectHarness(harness, client);
      await startTask(harness, client);
      await enterPlanningWorkflow(client);

      harness.sendCommand({
        commandName: TaskCommandName.SwitchModel,
        data: { model: FALLBACK_MODEL, reason: 'failover' },
      });

      await vi.waitFor(() => {
        expect(harness.getActiveModel()).toBe(FALLBACK_MODEL);
      });

      harness.sendCommand({
        commandName: TaskCommandName.SendMessage,
        data: { text: 'Keep planning.', visibleInTranscript: true },
      });

      await vi.waitFor(() => {
        expect(client.promptAsync).toHaveBeenCalledTimes(2);
      });

      // Failover means the previous provider is unusable, so planning has to
      // move even though the role model was pinned.
      expect(promptedModel(client, 1)).toEqual({
        providerID: 'anthropic',
        modelID: 'claude-opus-5',
      });
    } finally {
      harness.dispose();
    }
  });
});
