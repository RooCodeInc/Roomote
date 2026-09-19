import type { Message, Part, Session } from '@opencode-ai/sdk/v2/client';

import {
  cloneOpenCodeSessionSnapshotForImport,
  createOpenCodeSessionSnapshot,
  parseOpenCodeSessionSnapshot,
  sanitizeOpenCodeSessionSnapshot,
} from '../opencode-session-snapshot';

const sessionId = `ses_${'a'.repeat(26)}`;
const userMessageId = `msg_${'b'.repeat(26)}`;
const assistantMessageId = `msg_${'c'.repeat(26)}`;
const compactionMessageId = `msg_${'d'.repeat(26)}`;

function session(): Session {
  return {
    id: sessionId,
    slug: 'snapshot-test',
    projectID: 'global',
    directory: '/tmp/original',
    title: 'Snapshot test',
    version: '1.18.30',
    time: { created: 1, updated: 5 },
  };
}

function messages(): Array<{ info: Message; parts: Part[] }> {
  return [
    {
      info: {
        id: userMessageId,
        sessionID: sessionId,
        role: 'user',
        time: { created: 2 },
        agent: 'build',
        model: { providerID: 'test', modelID: 'test' },
      },
      parts: [
        {
          id: `prt_${'e'.repeat(26)}`,
          sessionID: sessionId,
          messageID: userMessageId,
          type: 'file',
          mime: 'image/png',
          filename: 'pixel.png',
          url: 'data:image/png;base64,AA==',
        },
      ],
    },
    {
      info: {
        id: assistantMessageId,
        sessionID: sessionId,
        role: 'assistant',
        time: { created: 3, completed: 4 },
        parentID: userMessageId,
        modelID: 'test',
        providerID: 'test',
        mode: 'build',
        agent: 'build',
        path: { cwd: '/tmp/original', root: '/tmp' },
        cost: 0,
        tokens: {
          input: 1,
          output: 1,
          reasoning: 0,
          cache: { read: 0, write: 0 },
        },
        finish: 'stop',
      },
      parts: [
        {
          id: `prt_${'f'.repeat(26)}`,
          sessionID: sessionId,
          messageID: assistantMessageId,
          type: 'tool',
          callID: 'call_original',
          tool: 'harmless',
          state: {
            status: 'completed',
            input: { value: 1 },
            output: 'done',
            title: 'Harmless',
            metadata: {},
            time: { start: 3, end: 4 },
          },
        },
      ],
    },
    {
      info: {
        id: compactionMessageId,
        sessionID: sessionId,
        role: 'user',
        time: { created: 5 },
        agent: 'build',
        model: { providerID: 'test', modelID: 'test' },
      },
      parts: [
        {
          id: `prt_${'0'.repeat(26)}`,
          sessionID: sessionId,
          messageID: compactionMessageId,
          type: 'compaction',
          auto: true,
          tail_start_id: userMessageId,
        },
      ],
    },
  ];
}

describe('OpenCode session snapshots', () => {
  it('captures only a settled session containing the expected completion', () => {
    const snapshot = createOpenCodeSessionSnapshot({
      info: session(),
      messages: messages(),
      expectedCompletedMessageId: assistantMessageId,
      capturedAt: 10,
    });

    expect(snapshot).toMatchObject({
      version: 1,
      sourceSessionId: sessionId,
      capturedAt: 10,
    });
    expect(
      createOpenCodeSessionSnapshot({
        info: session(),
        messages: messages(),
        expectedCompletedMessageId: 'missing',
      }),
    ).toBeNull();
  });

  it('rejects interrupted tool state and malformed persisted data', () => {
    const interrupted = messages();
    const tool = interrupted[1]!.parts[0]!;
    if (tool.type !== 'tool') throw new Error('Expected tool part.');
    tool.state = {
      status: 'running',
      input: {},
      time: { start: 3 },
    };

    expect(
      createOpenCodeSessionSnapshot({
        info: session(),
        messages: interrupted,
        expectedCompletedMessageId: assistantMessageId,
      }),
    ).toBeNull();
    expect(
      parseOpenCodeSessionSnapshot({
        version: 1,
        sourceSessionId: 'different',
        capturedAt: 1,
        info: session(),
        messages: [],
      }),
    ).toBeNull();
  });

  it('clones every identity while preserving roles, files, tool calls, and compaction links', () => {
    const snapshot = createOpenCodeSessionSnapshot({
      info: session(),
      messages: messages(),
      expectedCompletedMessageId: assistantMessageId,
      capturedAt: 10,
    })!;
    const restored = cloneOpenCodeSessionSnapshotForImport(snapshot);

    expect(restored.sourceSessionId).not.toBe(sessionId);
    expect(restored.messages.map(({ info }) => info.role)).toEqual([
      'user',
      'assistant',
      'user',
    ]);
    expect(restored.messages[0]!.parts[0]).toMatchObject({
      type: 'file',
      mime: 'image/png',
      url: 'data:image/png;base64,AA==',
    });
    expect(restored.messages[1]!.parts[0]).toMatchObject({
      type: 'tool',
      callID: 'call_original',
      state: { status: 'completed', output: 'done' },
    });
    expect(restored.messages[1]!.info).toMatchObject({
      parentID: restored.messages[0]!.info.id,
    });
    expect(restored.messages[2]!.parts[0]).toMatchObject({
      type: 'compaction',
      tail_start_id: restored.messages[0]!.info.id,
    });
    expect(
      restored.messages.every(({ info, parts }) =>
        parts.every(
          (part) =>
            part.sessionID === restored.sourceSessionId &&
            part.messageID === info.id,
        ),
      ),
    ).toBe(true);
    for (const { parts } of restored.messages) {
      expect(parts.map(({ id }) => id)).toEqual(
        parts.map(({ id }) => id).sort(),
      );
    }
  });

  it('keeps tool lifecycle identity while removing private payloads', () => {
    const snapshot = createOpenCodeSessionSnapshot({
      info: session(),
      messages: messages(),
      expectedCompletedMessageId: assistantMessageId,
    })!;
    const userInfo = snapshot.messages[0]!.info;
    if (userInfo.role !== 'user') throw new Error('Expected user message.');
    userInfo.system = 'private personalization';
    const redacted = sanitizeOpenCodeSessionSnapshot(
      snapshot,
      ({ callID }) => callID === 'call_original',
    );

    expect(redacted.messages[1]!.parts[0]).toMatchObject({
      type: 'tool',
      callID: 'call_original',
      tool: 'harmless',
      state: {
        status: 'completed',
        input: {},
        output: 'Private tool result omitted from durable recovery.',
      },
    });
    expect(redacted.messages[0]!.info).not.toHaveProperty('system');
  });
});
