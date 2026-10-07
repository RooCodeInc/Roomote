import type { AcpPersistedEnvelope } from '@roomote/types';

import {
  recordTaskMessageEnvelope,
  sanitizePrivatePersonalizationEnvelope,
} from './record-task-message-envelope';
import {
  db,
  eq,
  taskFactory,
  taskRuns,
  taskMessages,
  tasks,
} from '@roomote/db/server';
import { ACP_ENVELOPE_EVENT_TYPES, TaskPayloadKind } from '@roomote/types';

function envelope(payload: Record<string, unknown>): AcpPersistedEnvelope {
  return {
    ts: 1,
    eventType: 'roomote_runtime.tool_call',
    role: 'tool',
    protocol: 'roomote_runtime',
    contentBlocks: [{ type: 'text', text: 'PRIVATE_SENTINEL' }],
    metadata: null,
    payload,
  };
}

describe('personalization transcript privacy', () => {
  it.each([
    { toolName: 'update_personalization' },
    {
      update: {
        mcpToolName: 'roomote_update_personalization',
        rawInput: { arguments: { preference: 'PRIVATE_SENTINEL' } },
      },
    },
  ])('removes private arguments before persistence', (payload) => {
    const sanitized = sanitizePrivatePersonalizationEnvelope(envelope(payload));
    const serialized = JSON.stringify(sanitized);

    expect(serialized).not.toContain('PRIVATE_SENTINEL');
    expect(sanitized.metadata).toMatchObject({ visibleInTranscript: true });
    expect(sanitized.contentBlocks).toEqual([
      { type: 'text', text: 'Personalization updated' },
    ]);
    expect(sanitized.payload).toMatchObject({ private: true });
  });

  it('leaves ordinary tool payloads intact', () => {
    const original = envelope({
      toolName: 'read',
      rawInput: { arguments: { path: 'README.md' } },
    });

    expect(sanitizePrivatePersonalizationEnvelope(original).payload).toEqual(
      original.payload,
    );
  });
});

it('redacts nested diagnostics before insert and upsert without losing process metadata', async () => {
  const task = await taskFactory.create({
    title: 'Sanitized diagnostics',
    workflow: 'pr_review',
  });
  const [run] = await db
    .insert(taskRuns)
    .values({
      taskId: task.id,
      payloadKind: TaskPayloadKind.GithubPrReviewSync,
      payload: { repo: 'owner/repo' },
    })
    .returning();
  const sentinel = 'synthetic diagnostic value';
  const diagnostic = JSON.stringify([
    {
      name: 'api',
      pid: 123,
      pm2_env: { status: 'online', env: { CUSTOM_SETTING: sentinel } },
      headers: { Authorization: sentinel, 'X-Request-Id': 'request-1' },
    },
  ]);
  try {
    for (const status of ['running', 'completed']) {
      await recordTaskMessageEnvelope({
        taskId: task.id,
        runId: run!.id,
        envelope: {
          ...envelope({
            toolName: 'bash',
            output: diagnostic,
            status,
            diagnostic: { env: { CUSTOM_SETTING: sentinel } },
          }),
          eventType: ACP_ENVELOPE_EVENT_TYPES.ToolResult,
          contentBlocks: [{ type: 'text', text: diagnostic }],
        },
      });
      const row = await db.query.taskMessages.findFirst({
        where: eq(taskMessages.taskId, task.id),
      });
      const serialized = JSON.stringify(row);
      expect(serialized.includes(sentinel)).toBe(false);
      expect(serialized.includes('request-1')).toBe(true);
      expect(serialized.includes('online')).toBe(true);
    }
  } finally {
    await db.delete(taskMessages).where(eq(taskMessages.taskId, task.id));
    await db.delete(taskRuns).where(eq(taskRuns.taskId, task.id));
    await db.delete(tasks).where(eq(tasks.id, task.id));
  }
});
