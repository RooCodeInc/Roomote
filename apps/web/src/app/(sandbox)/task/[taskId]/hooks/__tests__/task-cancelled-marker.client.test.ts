import { ACP_ENVELOPE_EVENT_TYPES } from '@roomote/types';

vi.mock('@roomote/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@roomote/env')>();

  return {
    ...actual,
    Env: {
      NODE_ENV: 'test',
      DATABASE_URL: 'postgres://postgres:password@localhost:5432/test',
    },
  };
});

import {
  acpEnvelope,
  createAcpStore,
  textBlock,
} from './use-sandbox-store-test-kit';

const SESSION = 'ses_cancel';

function userPromptEnvelope(options: { id: string; ts: number; text: string }) {
  return acpEnvelope({
    id: options.id,
    ts: options.ts,
    eventType: ACP_ENVELOPE_EVENT_TYPES.UserPrompt,
    kind: 'text',
    role: 'user',
    text: options.text,
    contentBlocks: [textBlock(options.text)],
    metadata: { sessionId: SESSION },
    payload: { sessionId: SESSION, text: options.text },
  });
}

function assistantMessageEnvelope(options: {
  id: string;
  ts: number;
  messageId: string;
  text: string;
}) {
  return acpEnvelope({
    id: options.id,
    ts: options.ts,
    eventType: ACP_ENVELOPE_EVENT_TYPES.AssistantMessage,
    kind: 'text',
    role: 'assistant',
    text: options.text,
    contentBlocks: [textBlock(options.text)],
    metadata: { sessionId: SESSION, turnId: options.messageId },
    payload: {
      sessionId: SESSION,
      turnId: options.messageId,
      text: options.text,
    },
  });
}

function taskCancelledEnvelope(options: {
  id: string;
  ts: number;
  cancelledByName?: string;
  source?: string;
}) {
  const logicalEventId = `${SESSION}:cancel-${options.ts}:no-tool:${ACP_ENVELOPE_EVENT_TYPES.TaskCancelled}`;
  const text = options.cancelledByName
    ? `Stopped by ${options.cancelledByName}`
    : 'Stopped';

  return acpEnvelope({
    id: options.id,
    ts: options.ts,
    eventType: ACP_ENVELOPE_EVENT_TYPES.TaskCancelled,
    kind: 'task_cancelled',
    role: 'system',
    text,
    contentBlocks: [textBlock(text)],
    metadata: { sessionId: SESSION, logicalEventId },
    payload: {
      sessionId: SESSION,
      logicalEventId,
      ...(options.cancelledByName
        ? { cancelledByName: options.cancelledByName }
        : {}),
      ...(options.source ? { source: options.source } : {}),
    },
  });
}

describe('task_cancelled marker history reconstruction', () => {
  it('renders the marker after the aborted partial output', () => {
    const store = createAcpStore();

    store.getState()._loadAcpHistory([
      userPromptEnvelope({ id: 'env-1', ts: 1000, text: 'Refactor this.' }),
      assistantMessageEnvelope({
        id: 'env-2',
        ts: 1100,
        messageId: 'msg-a',
        text: 'Starting the refactor by mapping',
      }),
      taskCancelledEnvelope({
        id: 'env-3',
        ts: 1200,
        cancelledByName: 'Daniel',
        source: 'web',
      }),
    ]);

    const messages = store.getState().messages;
    const marker = messages.find((msg) => msg.kind === 'task_cancelled');

    expect(marker).toMatchObject({
      role: 'system',
      updateType: ACP_ENVELOPE_EVENT_TYPES.TaskCancelled,
      data: expect.objectContaining({
        cancelledByName: 'Daniel',
        source: 'web',
      }),
    });
    expect(messages.at(-1)?.kind).toBe('task_cancelled');
  });

  it('does not style the aborted trailing assistant message as a completed turn', () => {
    const store = createAcpStore();

    store.getState()._loadAcpHistory([
      userPromptEnvelope({ id: 'env-1', ts: 1000, text: 'Refactor this.' }),
      assistantMessageEnvelope({
        id: 'env-2',
        ts: 1100,
        messageId: 'msg-a',
        text: 'Starting the refactor by mapping',
      }),
      taskCancelledEnvelope({ id: 'env-3', ts: 1200 }),
    ]);

    const aborted = store
      .getState()
      .messages.find((msg) => msg.text === 'Starting the refactor by mapping');

    expect(aborted).toBeDefined();
    expect(aborted?.isTurnCompletion).not.toBe(true);
  });

  it('keeps marking uncancelled trailing turns as completed', () => {
    const store = createAcpStore();

    store.getState()._loadAcpHistory([
      userPromptEnvelope({ id: 'env-1', ts: 1000, text: 'Refactor this.' }),
      assistantMessageEnvelope({
        id: 'env-2',
        ts: 1100,
        messageId: 'msg-a',
        text: 'Done with the refactor.',
      }),
    ]);

    const answer = store
      .getState()
      .messages.find((msg) => msg.text === 'Done with the refactor.');

    expect(answer?.isTurnCompletion).toBe(true);
  });

  it('keeps a follow-up turn after a cancel marker intact', () => {
    const store = createAcpStore();

    store.getState()._loadAcpHistory([
      userPromptEnvelope({ id: 'env-1', ts: 1000, text: 'Refactor this.' }),
      assistantMessageEnvelope({
        id: 'env-2',
        ts: 1100,
        messageId: 'msg-a',
        text: 'Starting the refactor by mapping',
      }),
      taskCancelledEnvelope({
        id: 'env-3',
        ts: 1200,
        cancelledByName: 'Daniel',
      }),
      userPromptEnvelope({
        id: 'env-4',
        ts: 1300,
        text: 'Only do the config part.',
      }),
      assistantMessageEnvelope({
        id: 'env-5',
        ts: 1400,
        messageId: 'msg-b',
        text: 'Config-only refactor done.',
      }),
    ]);

    const roles = store
      .getState()
      .messages.map((msg) => `${msg.role}:${msg.kind}`);

    expect(roles).toEqual([
      'user:text',
      'assistant:text',
      'system:task_cancelled',
      'user:text',
      'assistant:text',
    ]);
  });
});
