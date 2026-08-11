const { mockCreateDiscordProvider, mockDiscordPostMessage, mockRedisSet } =
  vi.hoisted(() => ({
    mockCreateDiscordProvider: vi.fn(),
    mockDiscordPostMessage: vi.fn(),
    mockRedisSet: vi.fn(),
  }));

vi.mock('../../discord-communication', () => ({
  createDiscordCommunicationProviderFromRuntimeCredentials:
    mockCreateDiscordProvider,
}));

// This test covers the envelope -> notifier -> provider wiring, so keep the
// duplicate-suppression claim in-memory. A live Redis roundtrip here would make
// the assertion depend on connection latency rather than on the wiring.
vi.mock('@roomote/redis', () => ({
  getRedis: () => ({
    set: mockRedisSet,
    del: vi.fn().mockResolvedValue(1),
  }),
}));

import { db, taskFactory, taskRuns } from '@roomote/db/server';
import {
  ACP_ENVELOPE_EVENT_TYPES,
  TERMINAL_PROVIDER_ERROR_PAYLOAD_KEY,
  TaskPayloadKind,
  type AcpPersistedEnvelope,
} from '@roomote/types';

import { recordTaskMessageEnvelope } from '../record-task-message-envelope';

const PROVIDER_ERROR =
  'The provider returned an error: Our servers are currently overloaded. Please try again later.';

let messageTs = 2_000;

/**
 * Mirrors the assistant message the OpenCode harness emits when a provider
 * error is terminal for the turn: the error summary is stamped into both
 * metadata and payload.
 */
function buildTerminalProviderErrorEnvelope(): AcpPersistedEnvelope {
  messageTs += 1;

  return {
    ts: messageTs,
    eventType: ACP_ENVELOPE_EVENT_TYPES.AssistantMessage,
    role: 'assistant',
    protocol: 'roomote_runtime',
    contentBlocks: [{ type: 'text', text: PROVIDER_ERROR }],
    metadata: {
      sessionId: 'session-1',
      [TERMINAL_PROVIDER_ERROR_PAYLOAD_KEY]: { errorSummary: PROVIDER_ERROR },
    },
    payload: {
      sessionId: 'session-1',
      text: PROVIDER_ERROR,
      [TERMINAL_PROVIDER_ERROR_PAYLOAD_KEY]: { errorSummary: PROVIDER_ERROR },
    },
  } as unknown as AcpPersistedEnvelope;
}

function buildOrdinaryEnvelope(): AcpPersistedEnvelope {
  messageTs += 1;

  return {
    ts: messageTs,
    eventType: ACP_ENVELOPE_EVENT_TYPES.AssistantMessage,
    role: 'assistant',
    protocol: 'roomote_runtime',
    contentBlocks: [{ type: 'text', text: 'All done.' }],
    metadata: { sessionId: 'session-1' },
    payload: { sessionId: 'session-1', text: 'All done.' },
  } as unknown as AcpPersistedEnvelope;
}

async function seedDiscordTaskRun(taskId: string): Promise<number> {
  await taskFactory.create({
    id: taskId,
    modelProvider: 'roomote',
    model: 'test-model',
    title: 'Discord task',
    workflow: 'standard',
    surface: 'discord',
    trigger: 'manual',
  });

  const [run] = await db
    .insert(taskRuns)
    .values({
      payloadKind: TaskPayloadKind.StandardTask,
      payload: {
        repo: 'owner/repo',
        communicationProvider: 'discord',
        communicationChannelId: 'D555',
        communicationThreadId: 'T555',
      },
      taskId,
    })
    .returning({ id: taskRuns.id });

  if (!run) {
    throw new Error('Failed to seed task run');
  }

  return run.id;
}

describe('terminal provider error thread delivery wiring', () => {
  beforeEach(async () => {
    process.env.R_APP_URL = 'https://app.example.com';
    mockCreateDiscordProvider.mockReset();
    mockDiscordPostMessage.mockReset();
    mockRedisSet.mockReset();
    mockRedisSet.mockResolvedValue('OK');
    mockCreateDiscordProvider.mockResolvedValue({
      postMessage: mockDiscordPostMessage,
    });
    mockDiscordPostMessage.mockResolvedValue({
      provider: 'discord',
      channelId: 'D555',
      messageId: 'm1',
    });
  });

  it('reports the provider error into the source thread when the envelope is persisted', async () => {
    const taskId = 'task-terminal-provider-error';
    const runId = await seedDiscordTaskRun(taskId);

    await recordTaskMessageEnvelope({
      runId,
      taskId,
      envelope: buildTerminalProviderErrorEnvelope(),
    });

    // Delivery is scheduled off the message write, so let the fire-and-forget
    // notifier settle before asserting. The timeout is generous because the
    // notifier still performs a real task-run read.
    await vi.waitFor(
      () => expect(mockDiscordPostMessage).toHaveBeenCalledTimes(1),
      { timeout: 10_000, interval: 25 },
    );

    const [post] = mockDiscordPostMessage.mock.calls[0] ?? [];
    expect(post).toMatchObject({
      channelId: 'D555',
      threadId: 'T555',
      textFormat: 'markdown',
    });
    expect(post.text).toContain('provider error');
    expect(post.text).toContain(
      'Our servers are currently overloaded. Please try again later.',
    );
  });

  it('leaves ordinary assistant messages alone', async () => {
    const taskId = 'task-ordinary-assistant-message';
    const runId = await seedDiscordTaskRun(taskId);

    await recordTaskMessageEnvelope({
      runId,
      taskId,
      envelope: buildOrdinaryEnvelope(),
    });

    expect(mockDiscordPostMessage).not.toHaveBeenCalled();
  });
});
