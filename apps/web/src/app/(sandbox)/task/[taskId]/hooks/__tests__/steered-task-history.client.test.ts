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

const SESSION = 'ses_repro';

function userPromptEnvelope(options: {
  id: string;
  ts: number;
  text: string;
  clientMessageId?: string;
  visibleInTranscript?: boolean;
}) {
  const logicalEventId = `${SESSION}:${options.clientMessageId ?? 'no-turn'}:no-tool:${ACP_ENVELOPE_EVENT_TYPES.UserPrompt}`;

  return acpEnvelope({
    id: options.id,
    ts: options.ts,
    eventType: ACP_ENVELOPE_EVENT_TYPES.UserPrompt,
    kind: 'text',
    role: 'user',
    text: options.text,
    contentBlocks: [textBlock(options.text)],
    visibleInTranscript: options.visibleInTranscript,
    metadata: {
      sessionId: SESSION,
      logicalEventId,
      ...(options.clientMessageId
        ? { clientMessageId: options.clientMessageId }
        : {}),
      ...(options.visibleInTranscript === false
        ? { visibleInTranscript: false }
        : {}),
    },
    payload: {
      sessionId: SESSION,
      text: options.text,
      logicalEventId,
      ...(options.clientMessageId
        ? { clientMessageId: options.clientMessageId }
        : {}),
    },
  });
}

function assistantMessageEnvelope(options: {
  id: string;
  ts: number;
  messageId: string;
  text: string;
}) {
  const logicalEventId = `${SESSION}:${options.messageId}:no-tool:${ACP_ENVELOPE_EVENT_TYPES.AssistantMessage}`;

  return acpEnvelope({
    id: options.id,
    ts: options.ts,
    eventType: ACP_ENVELOPE_EVENT_TYPES.AssistantMessage,
    kind: 'text',
    role: 'assistant',
    ...(options.text.length > 0 ? { text: options.text } : {}),
    contentBlocks: options.text.length > 0 ? [textBlock(options.text)] : [],
    metadata: {
      sessionId: SESSION,
      turnId: options.messageId,
      logicalEventId,
    },
    payload: {
      sessionId: SESSION,
      turnId: options.messageId,
      text: options.text,
      logicalEventId,
    },
  });
}

function envelopeFixture() {
  return [
    userPromptEnvelope({
      id: 'env-1',
      ts: 1000,
      text: '<request>Investigate the queued follow-up flow</request>',
      visibleInTranscript: false,
    }),
    assistantMessageEnvelope({
      id: 'env-2',
      ts: 1100,
      messageId: 'msg-a',
      text: '',
    }),
    assistantMessageEnvelope({
      id: 'env-3',
      ts: 1200,
      messageId: 'msg-b',
      text: 'Reading the repo guidance and then tracing the flow.',
    }),
    assistantMessageEnvelope({
      id: 'env-4',
      ts: 1300,
      messageId: 'msg-c',
      text: '',
    }),
    assistantMessageEnvelope({
      id: 'env-5',
      ts: 1400,
      messageId: 'msg-d',
      text: 'Here is the full turn-one answer.',
    }),
    userPromptEnvelope({
      id: 'env-6',
      ts: 1500,
      text: 'Yes - produce the tighter walkthrough for all three flows.',
      clientMessageId: 'client-follow-up',
      visibleInTranscript: true,
    }),
    assistantMessageEnvelope({
      id: 'env-7',
      ts: 1600,
      messageId: 'msg-e',
      text: '',
    }),
    assistantMessageEnvelope({
      id: 'env-8',
      ts: 1700,
      messageId: 'msg-f',
      text: 'Here is the full turn-two answer.',
    }),
    userPromptEnvelope({
      id: 'env-9',
      ts: 1800,
      text: 'Quick change of direction: skip the snapshot-resume flow.',
      clientMessageId: 'client-steer',
      visibleInTranscript: true,
    }),
    assistantMessageEnvelope({
      id: 'env-10',
      ts: 1900,
      messageId: 'msg-g',
      text: 'Skipping snapshot resume. Here is the steered answer.',
    }),
  ];
}

describe('steered-task history reconstruction', () => {
  it('keeps every turn and user prompt after a reload-style history merge', () => {
    const store = createAcpStore();

    // Mirrors the persisted envelope stream of a real steered task
    // (openmote task 190holbb4xm2k): initial hidden prompt, a first turn
    // with interleaved empty assistant messages and a final answer, a
    // visible follow-up, a second turn, a steer, and the steered answer.
    store.getState()._mergeAcpHistory(envelopeFixture());

    const texts = store
      .getState()
      .messages.filter((msg) => (msg.text ?? '').length > 0)
      .map((msg) => ({ role: msg.role, text: msg.text }));

    expect(texts).toEqual([
      {
        role: 'user',
        text: '<request>Investigate the queued follow-up flow</request>',
      },
      {
        role: 'assistant',
        text: 'Reading the repo guidance and then tracing the flow.',
      },
      { role: 'assistant', text: 'Here is the full turn-one answer.' },
      {
        role: 'user',
        text: 'Yes - produce the tighter walkthrough for all three flows.',
      },
      { role: 'assistant', text: 'Here is the full turn-two answer.' },
      {
        role: 'user',
        text: 'Quick change of direction: skip the snapshot-resume flow.',
      },
      {
        role: 'assistant',
        text: 'Skipping snapshot resume. Here is the steered answer.',
      },
    ]);
  });

  it('keeps the transcript intact when a refetch merges over a loaded history', () => {
    const store = createAcpStore();

    // Initial page load hydrates via the envelope loader...
    store.getState()._loadAcpHistory(envelopeFixture());

    const loadedTexts = store
      .getState()
      .messages.filter((msg) => (msg.text ?? '').length > 0)
      .map((msg) => ({ role: msg.role, text: msg.text }));

    // ...then the connect-triggered envelope refetch merges the same
    // envelopes again (this is what happens on every live page).
    store.getState()._mergeAcpHistory(envelopeFixture());
    store.getState()._mergeAcpHistory(envelopeFixture());

    const mergedTexts = store
      .getState()
      .messages.filter((msg) => (msg.text ?? '').length > 0)
      .map((msg) => ({ role: msg.role, text: msg.text }));

    expect(mergedTexts).toEqual(loadedTexts);
  });

  it('inserts a refetched envelope the socket missed in timestamp order', () => {
    const store = createAcpStore();
    const fixture = envelopeFixture();

    // Page loads history before the steer prompt was persisted...
    store.getState()._loadAcpHistory(fixture.slice(0, 8));

    // ...the steered answer arrives over the live socket...
    store.getState()._handleAcpEvent(fixture[9] as never);

    // ...and the steer user prompt itself only shows up in the next
    // envelope refetch (the socket connection missed it).
    store.getState()._mergeAcpHistory(fixture);

    const texts = store
      .getState()
      .messages.filter((msg) => (msg.text ?? '').length > 0)
      .map((msg) => msg.text);

    const steerIndex = texts.findIndex((text) =>
      text?.startsWith('Quick change of direction'),
    );
    const answerIndex = texts.findIndex((text) =>
      text?.startsWith('Skipping snapshot resume'),
    );

    expect(steerIndex).toBeGreaterThan(-1);
    expect(answerIndex).toBeGreaterThan(-1);
    expect(steerIndex).toBeLessThan(answerIndex);
  });

  it('recovers the full transcript when live state has collapsed to a subset', () => {
    const store = createAcpStore();
    const fixture = envelopeFixture();

    // Simulate the corruption observed on live sessions (openmote task
    // 190holbb4xm2k, 2026-07-09): the in-memory transcript collapsed to just
    // the initial prompt and the latest answer while the server still held
    // every envelope.
    store.getState()._loadAcpHistory([fixture[0]!, fixture[9]!]);
    expect(store.getState().messages.length).toBeLessThan(4);

    // The next envelope refetch must converge the UI back to server truth.
    store.getState()._mergeAcpHistory(fixture);

    const texts = store
      .getState()
      .messages.filter((msg) => (msg.text ?? '').length > 0)
      .map((msg) => ({ role: msg.role, text: msg.text }));

    expect(texts).toEqual([
      {
        role: 'user',
        text: '<request>Investigate the queued follow-up flow</request>',
      },
      {
        role: 'assistant',
        text: 'Reading the repo guidance and then tracing the flow.',
      },
      { role: 'assistant', text: 'Here is the full turn-one answer.' },
      {
        role: 'user',
        text: 'Yes - produce the tighter walkthrough for all three flows.',
      },
      { role: 'assistant', text: 'Here is the full turn-two answer.' },
      {
        role: 'user',
        text: 'Quick change of direction: skip the snapshot-resume flow.',
      },
      {
        role: 'assistant',
        text: 'Skipping snapshot resume. Here is the steered answer.',
      },
    ]);
  });

  it('carries over optimistic and unpersisted live messages across a merge', () => {
    const store = createAcpStore();
    const fixture = envelopeFixture();

    store.getState()._loadAcpHistory(fixture);

    // An optimistic send still waiting for its envelope...
    store.getState()._appendOptimisticAcpEvent({
      id: 'local:optimistic-1',
      ts: 2000,
      eventType: ACP_ENVELOPE_EVENT_TYPES.UserPrompt,
      role: 'user',
      kind: 'text',
      text: 'One more question about the retry timer.',
      contentBlocks: [textBlock('One more question about the retry timer.')],
      metadata: { clientMessageId: 'client-optimistic-1' },
      payload: {
        text: 'One more question about the retry timer.',
        clientMessageId: 'client-optimistic-1',
      },
    } as never);

    // ...and a live assistant message whose envelope has not persisted yet.
    store.getState()._handleAcpEvent({
      id: 'opencode-server:99',
      ts: 2100,
      eventType: ACP_ENVELOPE_EVENT_TYPES.AssistantMessage,
      role: 'assistant',
      kind: 'text',
      text: 'Looking into the retry timer now.',
      contentBlocks: [textBlock('Looking into the retry timer now.')],
      metadata: {
        sessionId: SESSION,
        logicalEventId: `${SESSION}:msg-live-99:no-tool:${ACP_ENVELOPE_EVENT_TYPES.AssistantMessage}`,
      },
      payload: {
        sessionId: SESSION,
        text: 'Looking into the retry timer now.',
      },
    } as never);

    // A refetch that does NOT yet include either message must keep both.
    store.getState()._mergeAcpHistory(fixture);

    const texts = store.getState().messages.map((msg) => msg.text ?? '');
    expect(texts).toContain('One more question about the retry timer.');
    expect(texts).toContain('Looking into the retry timer now.');

    // They stay in timestamp order at the tail.
    const lastTwo = store.getState().messages.slice(-2);
    expect(lastTwo[0]?.text).toBe('One more question about the retry timer.');
    expect(lastTwo[1]?.text).toBe('Looking into the retry timer now.');
  });

  it('returns the same state reference when a refetch changes nothing', () => {
    const store = createAcpStore();
    const fixture = envelopeFixture();

    store.getState()._loadAcpHistory(fixture);
    const before = store.getState().messages;

    store.getState()._mergeAcpHistory(fixture);

    expect(store.getState().messages).toBe(before);
  });

  it('heals drifted message content that kept a persisted envelope id', () => {
    const store = createAcpStore();
    const fixture = envelopeFixture();

    // Live drift can leave a message with the right envelope id but wrong
    // content (e.g. a replacement applied at a stale index). An id-based
    // incremental merge skips such envelopes forever; the rebuild heals it.
    const drifted = fixture.map((envelope) =>
      envelope.id === 'env-5'
        ? {
            ...envelope,
            text: 'CORRUPTED',
            contentBlocks: [textBlock('CORRUPTED')],
          }
        : envelope,
    );

    store.getState()._loadAcpHistory(drifted);
    expect(
      store.getState().messages.some((msg) => msg.text === 'CORRUPTED'),
    ).toBe(true);

    store.getState()._mergeAcpHistory(fixture);

    const texts = store.getState().messages.map((msg) => msg.text ?? '');
    expect(texts).not.toContain('CORRUPTED');
    expect(texts).toContain('Here is the full turn-one answer.');
  });
});
