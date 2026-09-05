import {
  db,
  ensureAutomationRowsOnce,
  ensureSessionForFastConversation,
  eq,
  fastAgentConversations,
  fastAgentMessages,
  llmUsageEvents,
  runFactory,
  sessions,
  sql,
  taskArtifacts,
  taskFactory,
  userFactory,
} from '@roomote/db/server';
import { ACP_ENVELOPE_EVENT_TYPES, RunStatus } from '@roomote/types';

vi.mock('./artifact-signature', () => ({
  currentEpochSeconds: () => 7_300,
  signArtifactId: (artifactId: string, ts: number) => `sig-${artifactId}-${ts}`,
}));

import {
  findAccessibleFastSession,
  getFastSessionPrReviewOfferStatus,
  getFastSessionById,
  getFastSessionTasks,
  getFastSessionMessagesSince,
  getFastSessionDisplayTitle,
  getFastSessionSuggestableMessages,
  updateFastSessionPrReviewOfferStatus,
} from './fast-sessions';

async function createFastSession({
  userId,
  conversationId,
  updatedAt,
}: {
  userId: string;
  conversationId: string;
  updatedAt: Date;
}) {
  const [session] = await db
    .insert(fastAgentConversations)
    .values({
      userId,
      surface: 'slack',
      workspaceId: `workspace-${conversationId}`,
      conversationId,
      compatibilityMessages: [{ role: 'user', content: 'Hello' }],
      updatedAt,
    })
    .returning();

  return session!;
}

async function createFastMessage({
  conversationId,
  eventId,
  turnSeq,
  ts = 1,
  eventType = 'roomote_runtime.assistant_message',
  role = 'assistant',
  payload = {},
  metadata = { visibleInTranscript: true },
  contentBlocks,
}: {
  conversationId: string;
  eventId: string;
  turnSeq: number;
  ts?: number;
  eventType?: `roomote_runtime.${string}`;
  role?: 'user' | 'assistant' | 'tool';
  payload?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  contentBlocks?: Array<{ type: 'text'; text: string }>;
}) {
  const [message] = await db
    .insert(fastAgentMessages)
    .values({
      conversationId,
      eventId,
      turnId: 'turn-1',
      turnSeq,
      ts,
      eventType,
      role,
      contentBlocks: contentBlocks ?? [{ type: 'text', text: eventId }],
      metadata,
      payload,
      source: 'slack',
    })
    .returning();

  return message!;
}

describe('Fast session queries', () => {
  it.each(['history', 'polling'])(
    'enriches known task references with current non-deleted titles in %s',
    async (readMode) => {
      const owner = await userFactory.create();
      const session = await createFastSession({
        userId: owner.id,
        conversationId: `task-titles-${readMode}`,
        updatedAt: new Date(),
      });
      const task = await taskFactory.create({ title: 'Fix checkout' });
      const deleted = await taskFactory.create({
        title: 'Deleted title',
        deletedAt: new Date(),
      });
      const blank = await taskFactory.create({ title: ' ' });
      const payloads = [
        {
          toolName: 'send_task_message',
          rawInput: { arguments: { taskId: deleted.id } },
          output: JSON.stringify({ taskId: task.id }),
        },
        {
          toolName: 'send_task_message',
          rawInput: { taskId: task.id },
          output: 'Delivery failed',
        },
        {
          toolName: 'send_task_message',
          rawInput: { taskId: deleted.id },
          taskTitle: 'Stale title',
        },
        { toolName: 'send_task_message', rawInput: { taskId: 'missing-task' } },
        {
          toolName: 'send_task_message',
          rawInput: {},
          output: '{"delivered":true}',
        },
        { toolName: 'send_task_message', rawInput: { taskId: blank.id } },
      ];
      for (const [index, payload] of payloads.entries()) {
        await createFastMessage({
          conversationId: session.id,
          eventId: `title-${index}`,
          turnSeq: index,
          eventType: ACP_ENVELOPE_EVENT_TYPES.ToolResult,
          role: 'tool',
          payload,
        });
      }
      await createFastMessage({
        conversationId: session.id,
        eventId: 'incoming-title',
        turnSeq: payloads.length,
        eventType: ACP_ENVELOPE_EVENT_TYPES.UserPrompt,
        role: 'user',
        metadata: {
          visibleInTranscript: false,
          turnSource: 'platform_event',
          platformEventKind: 'delegated_task',
        },
        contentBlocks: [
          {
            type: 'text',
            text: `<platform_event>${JSON.stringify({ type: 'child_message', taskId: task.id, runId: 1, messageId: 'report-1', purpose: 'closeout', message: 'Finished' })}</platform_event>`,
          },
        ],
      });
      const result =
        readMode === 'history'
          ? await getFastSessionById(
              { userId: owner.id, isAdmin: false },
              session.id,
            )
          : await getFastSessionMessagesSince(session.id, 0);
      expect(
        result?.messages.map((message) => message.payload.taskTitle),
      ).toEqual([
        'Fix checkout',
        'Fix checkout',
        null,
        null,
        undefined,
        null,
        'Fix checkout',
      ]);
      expect(result?.messages.at(-1)?.payload).toMatchObject({
        toolName: 'receive_task_report',
        rawInput: { taskId: task.id },
      });
      expect(JSON.stringify(result?.messages)).not.toContain('Deleted title');
      const [persisted] = await db
        .select()
        .from(fastAgentMessages)
        .where(eq(fastAgentMessages.conversationId, session.id))
        .orderBy(fastAgentMessages.turnSeq)
        .limit(1);
      expect(persisted?.payload).not.toHaveProperty('taskTitle');
    },
  );

  it.each(['history', 'polling'])(
    'projects only valid incoming child reports as tool receipts in %s',
    async (readMode) => {
      const owner = await userFactory.create();
      const session = await createFastSession({
        userId: owner.id,
        conversationId: `child-receipts-${readMode}`,
        updatedAt: new Date('2026-01-01T00:00:00.000Z'),
      });
      const event = {
        type: 'child_message',
        taskId: 'child-task-1',
        runId: 42,
        messageId: 'report-1',
        purpose: 'closeout',
        message: '## Outcome\nLiteral child report, not the parent summary.',
        internalContext: 'Do not expose this extra field',
        imageArtifactIds: ['not-an-authorized-image'],
      };
      const metadata = {
        visibleInTranscript: false,
        turnSource: 'platform_event',
        platformEventKind: 'delegated_task',
        internalContext: 'Do not expose this metadata',
      };
      const wrapper = `<platform_event>${JSON.stringify(event)}</platform_event>`;
      const persisted = await createFastMessage({
        conversationId: session.id,
        eventId: 'receipt-row',
        turnSeq: 0,
        eventType: ACP_ENVELOPE_EVENT_TYPES.UserPrompt,
        role: 'user',
        contentBlocks: [{ type: 'text', text: wrapper }],
        metadata,
        payload: { internalContext: 'Do not expose this payload' },
      });
      const excluded = [
        { text: '<platform_event>not json</platform_event>', metadata },
        { text: wrapper, metadata: { ...metadata, turnSource: 'human' } },
        {
          text: wrapper,
          metadata: { ...metadata, platformEventKind: 'setup' },
        },
        { text: `Internal instructions\n${wrapper}`, metadata },
        ...[
          { type: 'task_settled' },
          { type: 'artifact_published' },
          { type: 'pull_request_feedback' },
          { runId: '42' },
          { taskId: '' },
          { messageId: null },
          { purpose: 'internal' },
          { message: null },
        ].map((overrides) => ({
          text: `<platform_event>${JSON.stringify({ ...event, ...overrides })}</platform_event>`,
          metadata,
        })),
      ];
      for (const [index, hidden] of excluded.entries()) {
        await createFastMessage({
          conversationId: session.id,
          eventId: `hidden-${index}`,
          turnSeq: index + 1,
          eventType: ACP_ENVELOPE_EVENT_TYPES.UserPrompt,
          role: 'user',
          contentBlocks: [{ type: 'text', text: hidden.text }],
          metadata: hidden.metadata,
        });
      }
      const result =
        readMode === 'history'
          ? await getFastSessionById(
              { userId: owner.id, isAdmin: false },
              session.id,
            )
          : await getFastSessionMessagesSince(session.id, 0);
      expect(result?.messages).toEqual([
        expect.objectContaining({
          id: persisted.id,
          eventId: 'receipt-row',
          eventType: ACP_ENVELOPE_EVENT_TYPES.ToolResult,
          role: 'tool',
          contentBlocks: [{ type: 'text', text: event.message }],
          metadata: { visibleInTranscript: true, toolCallId: 'receipt-row' },
          payload: {
            toolName: 'receive_task_report',
            taskTitle: null,
            toolCallId: 'receipt-row',
            status: 'completed',
            rawInput: {
              taskId: event.taskId,
              runId: 42,
              messageId: 'report-1',
              purpose: 'closeout',
            },
            output: event.message,
          },
        }),
      ]);
      expect(JSON.stringify(result?.messages)).not.toContain('platform_event');
      expect(JSON.stringify(result?.messages)).not.toContain('Do not expose');
      expect(JSON.stringify(result?.messages)).not.toContain(
        'not-an-authorized-image',
      );
      const [stored] = await db
        .select()
        .from(fastAgentMessages)
        .where(eq(fastAgentMessages.id, persisted.id));
      expect(stored?.metadata).toEqual(metadata);
      expect(stored?.contentBlocks).toEqual([{ type: 'text', text: wrapper }]);
      expect(await getFastSessionSuggestableMessages(session.id)).toEqual([]);

      await db
        .update(fastAgentMessages)
        .set({
          contentBlocks: [
            {
              type: 'text',
              text: `<platform_event>${JSON.stringify({ ...event, message: 'x'.repeat(100_000) })}</platform_event>`,
            },
          ],
        })
        .where(eq(fastAgentMessages.id, persisted.id));
      const truncated = await getFastSessionMessagesSince(session.id, 0);
      const payload = truncated.messages[0]?.payload as { output: string };
      expect(payload.output).toContain('[output truncated');
      expect(truncated.messages[0]?.contentBlocks).toEqual([
        { type: 'text', text: payload.output },
      ]);
    },
  );

  it.each([2, 1000, 1001])(
    'windows %i validated messages past a hidden delegated-event backlog',
    async (visibleCount) => {
      const owner = await userFactory.create();
      const session = await createFastSession({
        userId: owner.id,
        conversationId: `hidden-backlog-${visibleCount}`,
        updatedAt: new Date('2026-01-01T00:00:00.000Z'),
      });
      const metadata = {
        visibleInTranscript: false,
        turnSource: 'platform_event',
        platformEventKind: 'delegated_task',
      };
      await db.insert(fastAgentMessages).values(
        Array.from({ length: visibleCount + 1002 }, (_, index) => {
          const hidden = index >= visibleCount;
          const receipt = index === visibleCount - 1;
          return {
            conversationId: session.id,
            id: `${session.id.slice(0, 24)}${index.toString().padStart(12, '0')}`,
            eventId: `event-${index}`,
            turnId: `turn-${index}`,
            // Tie every ordering field except id, including a sub-ms timestamp.
            ts: 1,
            turnSeq: 0,
            createdAt: sql`'2026-01-01 00:00:00.123456+00'::timestamptz`,
            eventType:
              hidden || receipt
                ? ACP_ENVELOPE_EVENT_TYPES.UserPrompt
                : ACP_ENVELOPE_EVENT_TYPES.AssistantMessage,
            role:
              hidden || receipt ? ('user' as const) : ('assistant' as const),
            metadata:
              hidden || receipt ? metadata : { visibleInTranscript: true },
            contentBlocks: [
              {
                type: 'text' as const,
                text: hidden
                  ? index % 2 === 0
                    ? '<platform_event>not json</platform_event>'
                    : '<platform_event>{"type":"task_settled"}</platform_event>'
                  : receipt
                    ? '<platform_event>{"type":"child_message","taskId":"child-task","runId":42,"messageId":"report-1","purpose":"closeout","message":"Child report"}</platform_event>'
                    : `Visible message ${index}`,
              },
            ],
            payload: {},
            source: 'slack',
          };
        }),
      );

      const result = await getFastSessionById(
        { userId: owner.id, isAdmin: false },
        session.id,
      );
      const expectedCount = Math.min(visibleCount, 1000);
      expect(result?.hasOlderMessages).toBe(visibleCount > 1000);
      expect(result?.messages.map((message) => message.eventId)).toEqual(
        Array.from(
          { length: expectedCount },
          (_, index) => `event-${visibleCount - expectedCount + index}`,
        ),
      );
      expect(result?.messages.at(-1)).toMatchObject({
        eventType: ACP_ENVELOPE_EVENT_TYPES.ToolResult,
        payload: { toolName: 'receive_task_report', output: 'Child report' },
      });
      expect(JSON.stringify(result?.messages)).not.toContain('platform_event');
    },
  );

  it('returns only the newest 60 visible conversational suggestion messages', async () => {
    const owner = await userFactory.create();
    const conversation = await createFastSession({
      userId: owner.id,
      conversationId: 'bounded-composer-suggestion-history',
      updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    });

    await db.insert(fastAgentMessages).values([
      ...Array.from({ length: 61 }, (_, index) => ({
        conversationId: conversation.id,
        eventId: `suggestion-message-${index}`,
        turnId: `turn-${index}`,
        turnSeq: 0,
        ts: index + 1,
        eventType: ACP_ENVELOPE_EVENT_TYPES.AssistantMessage,
        role: 'assistant' as const,
        contentBlocks: [
          { type: 'text' as const, text: `suggestion-message-${index}` },
        ],
        metadata: { visibleInTranscript: true },
        payload: {},
        source: 'web',
      })),
      {
        conversationId: conversation.id,
        eventId: 'hidden-suggestion-message',
        turnId: 'hidden-turn',
        turnSeq: 0,
        ts: 62,
        eventType: ACP_ENVELOPE_EVENT_TYPES.UserPrompt,
        role: 'user' as const,
        contentBlocks: [{ type: 'text' as const, text: 'hidden prompt' }],
        metadata: { visibleInTranscript: false },
        payload: {},
        source: 'web',
      },
      {
        conversationId: conversation.id,
        eventId: 'tool-suggestion-message',
        turnId: 'tool-turn',
        turnSeq: 0,
        ts: 63,
        eventType: ACP_ENVELOPE_EVENT_TYPES.ToolCall,
        role: 'tool' as const,
        contentBlocks: [{ type: 'text' as const, text: 'tool payload' }],
        metadata: { visibleInTranscript: true },
        payload: {},
        source: 'web',
      },
    ]);

    const messages = await getFastSessionSuggestableMessages(conversation.id);

    expect(messages).toHaveLength(60);
    expect(messages[0]?.text).toBe('suggestion-message-1');
    expect(messages.at(-1)?.text).toBe('suggestion-message-60');
    expect(messages.map((message) => message.text)).not.toContain(
      'hidden prompt',
    );
    expect(messages.map((message) => message.text)).not.toContain(
      'tool payload',
    );
  });

  it('prefers the unified Session title for live Fast updates', async () => {
    const owner = await userFactory.create();
    const conversation = await createFastSession({
      userId: owner.id,
      conversationId: 'unified-display-title',
      updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    });
    const session = await ensureSessionForFastConversation(db, conversation.id);
    await db
      .update(sessions)
      .set({
        title: 'Manual unified title',
        titleEditedByUserAt: new Date(),
      })
      .where(eq(sessions.id, session.id));
    await db
      .update(fastAgentConversations)
      .set({ title: 'Generated conversation title' })
      .where(eq(fastAgentConversations.id, conversation.id));

    await expect(
      getFastSessionDisplayTitle(
        conversation.id,
        'Generated conversation title',
      ),
    ).resolves.toBe('Manual unified title');
  });

  it('shares detail lookups deployment-wide like tasks', async () => {
    const owner = await userFactory.create();
    const otherUser = await userFactory.create();
    const session = await createFastSession({
      userId: owner.id,
      conversationId: 'private-session',
      updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    });

    await expect(
      getFastSessionById({ userId: otherUser.id, isAdmin: false }, session.id),
    ).resolves.toMatchObject({ id: session.id, userId: owner.id });
    await expect(
      getFastSessionById({ userId: otherUser.id, isAdmin: true }, session.id),
    ).resolves.toMatchObject({ id: session.id, userId: owner.id });
  });

  it('returns automation-owned Session details to authenticated deployment users', async () => {
    const viewer = await userFactory.create();
    await ensureAutomationRowsOnce();
    const [conversation] = await db
      .insert(fastAgentConversations)
      .values({
        userId: null,
        ownerAutomation: 'custom_automation',
        surface: 'automation',
        workspaceId: crypto.randomUUID(),
        conversationId: crypto.randomUUID(),
        title: 'Weekly product update',
      })
      .returning();
    const unifiedSession = await ensureSessionForFastConversation(
      db,
      conversation!.id,
    );

    await expect(
      getFastSessionById(
        { userId: viewer.id, isAdmin: false },
        conversation!.id,
      ),
    ).resolves.toMatchObject({
      id: conversation!.id,
      userId: null,
      ownerAutomation: 'custom_automation',
      title: 'Weekly product update',
    });

    await db.delete(sessions).where(eq(sessions.id, unifiedSession.id));
    await db
      .delete(fastAgentConversations)
      .where(eq(fastAgentConversations.id, conversation!.id));
  });

  it('resolves reply image artifacts to signed raw URLs', async () => {
    const owner = await userFactory.create();
    const session = await createFastSession({
      userId: owner.id,
      conversationId: 'reply-images-session',
      updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    });
    const task = await taskFactory.create({
      title: 'Screenshot task',
      state: 'active',
    });
    await runFactory.create({
      taskId: task.id,
      status: RunStatus.Completed,
      payload: {
        repo: 'acme/widgets',
        description: 'Capture a screenshot',
        fastAgentSessionId: session.id,
      },
    });
    const foreignTask = await taskFactory.create({
      title: 'Unrelated task',
      state: 'active',
    });
    const [screenshot, report, foreignImage] = await db
      .insert(taskArtifacts)
      .values([
        {
          taskId: task.id,
          path: 'proof/session.png',
          version: 1,
          contentType: 'image/png',
          size: 2_048,
          uploaded: true,
        },
        {
          taskId: task.id,
          path: 'reports/result.md',
          version: 1,
          contentType: 'text/markdown',
          size: 200,
          uploaded: true,
        },
        {
          taskId: foreignTask.id,
          path: 'proof/other.png',
          version: 1,
          contentType: 'image/png',
          size: 2_048,
          uploaded: true,
        },
      ])
      .returning({ id: taskArtifacts.id });
    await createFastMessage({
      conversationId: session.id,
      eventId: 'turn-1:assistant:0',
      turnSeq: 1,
      payload: {
        purpose: 'closeout',
        imageArtifactIds: [
          screenshot!.id,
          report!.id,
          foreignImage!.id,
          crypto.randomUUID(),
          'not-a-uuid',
          '',
        ],
      },
    });

    const expectedImages = [
      `/api/artifacts/${screenshot!.id}/raw?sig=sig-${screenshot!.id}-7200&ts=7200`,
    ];
    const expectedImageArtifacts = [
      {
        url: expectedImages[0],
        owner: { taskId: task.id },
        path: 'proof/session.png',
        version: 1,
      },
    ];
    const detail = await getFastSessionById(
      { userId: owner.id, isAdmin: false },
      session.id,
    );
    expect(detail?.messages.map((message) => message.payload)).toEqual([
      expect.objectContaining({
        images: expectedImages,
        imageArtifacts: expectedImageArtifacts,
      }),
    ]);

    const since = await getFastSessionMessagesSince(session.id, 0);
    expect(since.messages.map((message) => message.payload)).toEqual([
      expect.objectContaining({
        images: expectedImages,
        imageArtifacts: expectedImageArtifacts,
      }),
    ]);
  });

  it('lists every task associated with a Fast session', async () => {
    const owner = await userFactory.create();
    const session = await createFastSession({
      userId: owner.id,
      conversationId: 'tasks-session',
      updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    });
    const delegatedTask = await taskFactory.create({
      title: 'Delegated task',
      state: 'active',
    });
    await runFactory.create({
      taskId: delegatedTask.id,
      status: RunStatus.Running,
      taskPhase: 'running',
      payload: {
        repo: 'acme/widgets',
        description: 'Delegated Fast task',
        fastAgentSessionId: session.id,
      },
    });
    const zeroCostTask = await taskFactory.create({
      title: 'Zero cost task',
      state: 'active',
    });
    await runFactory.create({
      taskId: zeroCostTask.id,
      status: RunStatus.Completed,
      payload: {
        repo: 'acme/widgets',
        description: 'Another delegated Fast task',
        fastAgentSessionId: session.id,
      },
    });
    await db.insert(llmUsageEvents).values({
      eventKey: `fast-task-cost-${crypto.randomUUID()}`,
      taskId: delegatedTask.id,
      costSource: 'missing',
      costMicroUsd: 750_000,
    });
    await db.insert(taskArtifacts).values([
      {
        taskId: delegatedTask.id,
        path: 'reports/result.md',
        version: 2,
        contentType: 'text/markdown',
        size: 200,
        uploaded: true,
      },
      {
        taskId: delegatedTask.id,
        path: 'reports/pending.md',
        version: 1,
        contentType: 'text/markdown',
        size: 0,
        uploaded: false,
      },
    ]);

    const result = await getFastSessionTasks(
      { userId: owner.id, isAdmin: false },
      session.id,
    );

    expect(result).toHaveLength(2);
    expect(result).toEqual(
      expect.arrayContaining([
        {
          taskId: delegatedTask.id,
          title: 'Delegated task',
          inferenceCostMicroUsd: 750_000,
          artifacts: [
            expect.objectContaining({
              path: 'reports/result.md',
              version: 2,
            }),
          ],
          previews: [],
          latestRun: {
            status: RunStatus.Running,
            taskPhase: 'running',
          },
        },
        {
          taskId: zeroCostTask.id,
          title: 'Zero cost task',
          inferenceCostMicroUsd: 0,
          artifacts: [],
          previews: [],
          latestRun: {
            status: RunStatus.Completed,
            taskPhase: null,
          },
        },
      ]),
    );
  });

  it('collates live preview URLs from awake delegated task runs', async () => {
    const owner = await userFactory.create();
    const session = await createFastSession({
      userId: owner.id,
      conversationId: 'preview-session',
      updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    });
    const awakeTask = await taskFactory.create({
      title: 'Awake task',
      state: 'active',
    });
    const awakeRun = await runFactory.create({
      taskId: awakeTask.id,
      status: RunStatus.Running,
      taskPhase: 'running',
      machineDomains: {
        WEB_APP: 'web.internal',
        API: 'api.internal',
        SANDBOX_SERVER: 'sandbox.internal',
      },
      initialPaths: { WEB_APP: '/dashboard' },
      primaryPortName: 'WEB_APP',
      payload: {
        repo: 'acme/widgets',
        description: 'Awake Fast task',
        fastAgentSessionId: session.id,
      },
    });
    const sleepingTask = await taskFactory.create({
      title: 'Sleeping task',
      state: 'active',
    });
    await runFactory.create({
      taskId: sleepingTask.id,
      status: RunStatus.Idle,
      machineDomains: { WEB_APP: 'sleeping.internal' },
      snapshotId: 'snapshot-1',
      payload: {
        repo: 'acme/widgets',
        description: 'Sleeping Fast task',
        fastAgentSessionId: session.id,
      },
    });

    const result = await getFastSessionTasks(
      { userId: owner.id, isAdmin: false },
      session.id,
    );

    const awake = result?.find((task) => task.taskId === awakeTask.id);
    expect(awake?.previews).toEqual([
      {
        serviceName: 'WEB_APP',
        url: expect.stringContaining(`${awakeTask.id}-web-app`),
        isPrimary: true,
        runId: awakeRun.id,
      },
      {
        serviceName: 'API',
        url: expect.stringContaining(`${awakeTask.id}-api`),
        isPrimary: false,
        runId: awakeRun.id,
      },
    ]);
    expect(awake?.previews[0]?.url).toContain('/dashboard');
    const sleeping = result?.find((task) => task.taskId === sleepingTask.id);
    expect(sleeping?.previews).toEqual([]);
  });

  it('keeps task-linked usage out of the legacy Fast direct cost', async () => {
    const owner = await userFactory.create();
    const nativeSessionId = `native-${crypto.randomUUID()}`;
    const session = await createFastSession({
      userId: owner.id,
      conversationId: 'direct-cost-session',
      updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    });
    await db
      .update(fastAgentConversations)
      .set({ openCodeSessionId: nativeSessionId })
      .where(eq(fastAgentConversations.id, session.id));
    const task = await taskFactory.create({ title: 'Delegated task' });
    await runFactory.create({
      taskId: task.id,
      payload: {
        repo: 'acme/widgets',
        description: 'Delegated Fast task',
        fastAgentSessionId: session.id,
      },
    });
    await db.insert(llmUsageEvents).values([
      {
        eventKey: `fast-direct-${crypto.randomUUID()}`,
        harnessSessionId: nativeSessionId,
        messageId: `message-${crypto.randomUUID()}`,
        costSource: 'missing',
        costMicroUsd: 250_000,
      },
      {
        eventKey: `fast-task-${crypto.randomUUID()}`,
        harnessSessionId: nativeSessionId,
        messageId: `message-${crypto.randomUUID()}`,
        taskId: task.id,
        costSource: 'missing',
        costMicroUsd: 500_000,
      },
    ]);

    const detail = await getFastSessionById(
      { userId: owner.id, isAdmin: false },
      session.id,
    );
    const taskCosts = await getFastSessionTasks(
      { userId: owner.id, isAdmin: false },
      session.id,
    );

    expect(detail).toMatchObject({
      directInferenceCostMicroUsd: 250_000,
      inferenceCostMicroUsd: 250_000,
    });
    expect(taskCosts).toEqual([
      expect.objectContaining({
        taskId: task.id,
        inferenceCostMicroUsd: 500_000,
      }),
    ]);
  });

  it('reads canonical messages in timestamp and turn sequence order', async () => {
    const owner = await userFactory.create({
      name: 'Slack Sender',
      email: 'sender@example.com',
      imageUrl: 'https://example.com/sender.png',
    });
    const session = await createFastSession({
      userId: owner.id,
      conversationId: 'ordered-session',
      updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    });
    await createFastMessage({
      conversationId: session.id,
      eventId: 'turn-1:assistant:0',
      turnSeq: 1,
      ts: 100,
    });
    await createFastMessage({
      conversationId: session.id,
      eventId: 'turn-1:user',
      turnSeq: 0,
      ts: 100,
      role: 'user',
      eventType: 'roomote_runtime.user_prompt',
      metadata: { visibleInTranscript: true, userId: owner.id },
    });

    const result = await getFastSessionById(
      { userId: owner.id, isAdmin: false },
      session.id,
    );

    expect(result?.messages.map((message) => message.eventId)).toEqual([
      'turn-1:user',
      'turn-1:assistant:0',
    ]);
    expect(result?.messages[0]).toMatchObject({
      userName: 'Slack Sender',
      userEmail: 'sender@example.com',
      userImageUrl: 'https://example.com/sender.png',
    });
  });

  it('does not fall back to compatibility messages for existing sessions', async () => {
    const owner = await userFactory.create();
    const session = await createFastSession({
      userId: owner.id,
      conversationId: 'legacy-only-session',
      updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    });

    const result = await getFastSessionById(
      { userId: owner.id, isAdmin: false },
      session.id,
    );

    expect(session.compatibilityMessages).toHaveLength(1);
    expect(result?.messages).toEqual([]);
    expect(result?.messageCount).toBe(0);
  });

  it('returns visible native tool event payloads unchanged', async () => {
    const owner = await userFactory.create();
    const session = await createFastSession({
      userId: owner.id,
      conversationId: 'native-tool-session',
      updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    });
    await createFastMessage({
      conversationId: session.id,
      eventId: 'turn-1:tool-result:0',
      turnSeq: 2,
      eventType: 'roomote_runtime.tool_result',
      role: 'tool',
      payload: {
        toolCallId: 'turn-1:tool:0',
        toolName: 'launch_task',
        status: 'completed',
        output: '{"delivered":true}',
      },
    });

    const result = await getFastSessionById(
      { userId: owner.id, isAdmin: false },
      session.id,
    );

    expect(result?.messages[0]?.payload).toMatchObject({
      toolCallId: 'turn-1:tool:0',
      toolName: 'launch_task',
      status: 'completed',
    });
  });

  it('hides send_chat_reply tool events while keeping the delivered reply', async () => {
    const owner = await userFactory.create();
    const session = await createFastSession({
      userId: owner.id,
      conversationId: 'hidden-reply-tool-session',
      updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    });
    await createFastMessage({
      conversationId: session.id,
      eventId: 'turn-1:tool:0',
      turnSeq: 1,
      eventType: 'roomote_runtime.tool_result',
      role: 'tool',
      metadata: { visibleInTranscript: false },
      payload: {
        toolCallId: 'turn-1:tool:0',
        toolName: 'send_chat_reply',
        status: 'completed',
        output: '{"delivered":true}',
      },
    });
    await createFastMessage({
      conversationId: session.id,
      eventId: 'turn-1:assistant:0',
      turnSeq: 2,
      eventType: 'roomote_runtime.assistant_message',
      role: 'assistant',
    });

    const result = await getFastSessionById(
      { userId: owner.id, isAdmin: false },
      session.id,
    );

    expect(result?.messages.map((message) => message.eventId)).toEqual([
      'turn-1:assistant:0',
    ]);
    expect(result?.messages[0]?.contentBlocks).toEqual([
      { type: 'text', text: 'turn-1:assistant:0' },
    ]);
  });

  it('grants every deployment user access to shared conversations', async () => {
    const owner = await userFactory.create();
    const participant = await userFactory.create();
    const bystander = await userFactory.create();
    const session = await createFastSession({
      userId: owner.id,
      conversationId: 'shared-thread',
      updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    });
    await createFastMessage({
      conversationId: session.id,
      eventId: 'turn-1:user',
      turnSeq: 0,
      role: 'user',
      eventType: 'roomote_runtime.user_prompt',
      metadata: { visibleInTranscript: true, userId: participant.id },
    });

    const participantAuth = { userId: participant.id, isAdmin: false };
    await expect(
      getFastSessionById(participantAuth, session.id),
    ).resolves.toMatchObject({ id: session.id });

    await expect(
      getFastSessionById({ userId: bystander.id, isAdmin: false }, session.id),
    ).resolves.toMatchObject({ id: session.id });
  });

  it('shows only the configured prompt from hidden custom automation events', async () => {
    const owner = await userFactory.create();
    const session = await createFastSession({
      userId: owner.id,
      conversationId: 'platform-event-session',
      updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    });
    await createFastMessage({
      conversationId: session.id,
      eventId: 'turn-1:automation',
      turnSeq: 0,
      role: 'user',
      eventType: 'roomote_runtime.user_prompt',
      contentBlocks: [
        {
          type: 'text',
          text: '<platform_event>{"type":"automation_triggered","prompt":"Find actionable regressions."}</platform_event>',
        },
      ],
      metadata: {
        visibleInTranscript: false,
        turnSource: 'platform_event',
        platformEventKind: 'automation',
      },
    });
    await createFastMessage({
      conversationId: session.id,
      eventId: 'turn-1:delegated-task',
      turnSeq: 1,
      role: 'user',
      eventType: 'roomote_runtime.user_prompt',
      contentBlocks: [
        {
          type: 'text',
          text: '<platform_event>{"type":"task_settled","secret":"internal"}</platform_event>',
        },
      ],
      metadata: {
        visibleInTranscript: false,
        turnSource: 'platform_event',
        platformEventKind: 'delegated_task',
      },
    });
    await createFastMessage({
      conversationId: session.id,
      eventId: 'turn-1:assistant:0',
      turnSeq: 2,
    });

    const result = await getFastSessionById(
      { userId: owner.id, isAdmin: false },
      session.id,
    );

    expect(result?.messages.map((message) => message.eventId)).toEqual([
      'turn-1:automation',
      'turn-1:assistant:0',
    ]);
    expect(result?.messages[0]).toMatchObject({
      contentBlocks: [{ type: 'text', text: 'Find actionable regressions.' }],
      metadata: {
        visibleInTranscript: true,
        platformEventKind: 'automation',
      },
      payload: {},
    });
    expect(JSON.stringify(result?.messages)).not.toContain('<platform_event>');
    expect(JSON.stringify(result?.messages)).not.toContain('internal');
  });

  it('streams only the configured prompt from hidden custom automation events', async () => {
    const owner = await userFactory.create();
    const session = await createFastSession({
      userId: owner.id,
      conversationId: 'platform-event-stream',
      updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    });
    await createFastMessage({
      conversationId: session.id,
      eventId: 'turn-1:automation',
      turnSeq: 0,
      role: 'user',
      eventType: 'roomote_runtime.user_prompt',
      contentBlocks: [
        {
          type: 'text',
          text: '<platform_event>{"type":"automation_triggered","prompt":"Summarize incidents."}</platform_event>',
        },
      ],
      metadata: {
        visibleInTranscript: false,
        turnSource: 'platform_event',
        platformEventKind: 'automation',
      },
    });
    await createFastMessage({
      conversationId: session.id,
      eventId: 'turn-1:malformed-automation',
      turnSeq: 1,
      role: 'user',
      eventType: 'roomote_runtime.user_prompt',
      contentBlocks: [
        { type: 'text', text: '<platform_event>{not-json}</platform_event>' },
      ],
      metadata: {
        visibleInTranscript: false,
        turnSource: 'platform_event',
        platformEventKind: 'automation',
      },
    });

    const result = await getFastSessionMessagesSince(session.id, 0);

    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]).toMatchObject({
      eventId: 'turn-1:automation',
      contentBlocks: [{ type: 'text', text: 'Summarize incidents.' }],
      metadata: { visibleInTranscript: true },
      payload: {},
    });
    expect(JSON.stringify(result.messages)).not.toContain('<platform_event>');
  });

  it('truncates oversized tool output at the read boundary', async () => {
    const owner = await userFactory.create();
    const session = await createFastSession({
      userId: owner.id,
      conversationId: 'oversized-output-session',
      updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    });
    const oversized = 'x'.repeat(30_000);
    await createFastMessage({
      conversationId: session.id,
      eventId: 'turn-1:tool-result:0',
      turnSeq: 2,
      eventType: 'roomote_runtime.tool_result',
      role: 'tool',
      payload: {
        toolCallId: 'turn-1:tool:0',
        toolName: 'send_chat_reply',
        status: 'completed',
        output: oversized,
      },
    });

    const result = await getFastSessionById(
      { userId: owner.id, isAdmin: false },
      session.id,
    );

    const payload = result?.messages[0]?.payload as Record<string, unknown>;
    expect((payload.output as string).length).toBeLessThan(oversized.length);
    expect(payload.output).toContain('[output truncated');
  });

  it('returns a persisted canonical subagent row in cold transcript history', async () => {
    const owner = await userFactory.create();
    const session = await createFastSession({
      userId: owner.id,
      conversationId: 'cold-subagent-session',
      updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    });
    await createFastMessage({
      conversationId: session.id,
      eventId: 'turn-1:subagent:assistant-1:part-1',
      turnSeq: 1,
      eventType: ACP_ENVELOPE_EVENT_TYPES.ToolResult,
      role: 'tool',
      payload: {
        toolCallId: 'task-call-1',
        kind: 'subagent',
        title: 'Review the implementation',
        status: 'completed',
        isSubagentSpawn: true,
        senderThreadId: 'opencode-session-1',
        receiverThreadIds: [],
        agentType: 'general',
        output: 'Implementation looks correct.',
      },
    });

    const result = await getFastSessionById(
      { userId: owner.id, isAdmin: false },
      session.id,
    );

    expect(result?.messages).toEqual([
      expect.objectContaining({
        eventId: 'turn-1:subagent:assistant-1:part-1',
        eventType: ACP_ENVELOPE_EVENT_TYPES.ToolResult,
        metadata: { visibleInTranscript: true },
        payload: expect.objectContaining({
          kind: 'subagent',
          status: 'completed',
          agentType: 'general',
          output: 'Implementation looks correct.',
        }),
      }),
    ]);
  });

  it('windows long transcripts to whole turns and flags older messages', async () => {
    const owner = await userFactory.create();
    const session = await createFastSession({
      userId: owner.id,
      conversationId: 'long-session',
      updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    });
    // 101 turns x 10 events = 1010 rows; the newest 1000 land mid-turn.
    const rows = Array.from({ length: 1010 }, (_, index) => ({
      conversationId: session.id,
      eventId: `event-${index}`,
      turnId: `turn-${Math.floor(index / 10)}`,
      turnSeq: index % 10,
      ts: index + 1,
      eventType: 'roomote_runtime.assistant_message' as const,
      role: 'assistant' as const,
      contentBlocks: [{ type: 'text' as const, text: `event-${index}` }],
      metadata: { visibleInTranscript: true },
      payload: {},
      source: 'slack',
    }));
    await db.insert(fastAgentMessages).values(rows);

    const result = await getFastSessionById(
      { userId: owner.id, isAdmin: false },
      session.id,
    );

    expect(result?.hasOlderMessages).toBe(true);
    expect(result?.messages.length).toBeLessThanOrEqual(1000);
    // The oldest included message starts its turn.
    expect(result?.messages[0]?.turnSeq).toBe(0);
    // The newest messages are the ones kept.
    expect(result?.messages.at(-1)?.eventId).toBe('event-1009');
  });

  it('streams only rows updated after the cursor and advances it', async () => {
    const owner = await userFactory.create({ name: 'Stream Sender' });
    const session = await createFastSession({
      userId: owner.id,
      conversationId: 'stream-session',
      updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    });
    await createFastMessage({
      conversationId: session.id,
      eventId: 'turn-1:user',
      turnSeq: 0,
      ts: 1,
      role: 'user',
      eventType: 'roomote_runtime.user_prompt',
      metadata: {
        visibleInTranscript: true,
        userId: owner.id,
        userName: 'Slack Display Name',
      },
    });
    await createFastMessage({
      conversationId: session.id,
      eventId: 'turn-1:hidden',
      turnSeq: 1,
      ts: 2,
      role: 'user',
      eventType: 'roomote_runtime.user_prompt',
      metadata: { visibleInTranscript: false },
    });

    const first = await getFastSessionMessagesSince(session.id, 0);
    expect(first.messages.map((message) => message.eventId)).toEqual([
      'turn-1:user',
    ]);
    expect(first.messages[0]).toMatchObject({
      userName: 'Slack Display Name',
      userEmail: expect.any(String),
    });
    expect(first.cursor).toBeGreaterThan(0);

    const second = await getFastSessionMessagesSince(session.id, first.cursor);
    expect(second.messages).toEqual([]);

    await createFastMessage({
      conversationId: session.id,
      eventId: 'turn-1:assistant:0',
      turnSeq: 2,
      ts: 3,
    });
    const third = await getFastSessionMessagesSince(session.id, first.cursor);
    expect(third.messages.map((message) => message.eventId)).toEqual([
      'turn-1:assistant:0',
    ]);
  });

  it('streams an in-place review offer retirement', async () => {
    const owner = await userFactory.create();
    const session = await createFastSession({
      userId: owner.id,
      conversationId: 'review-offer-stream',
      updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    });
    const deliveryId = '11111111-1111-4111-8111-111111111111';
    await createFastMessage({
      conversationId: session.id,
      eventId: 'turn-1:assistant:review',
      turnSeq: 1,
      payload: {
        prReviewAction: {
          deliveryId,
          question: 'Resolve these issues?',
          status: 'pending',
        },
      },
    });
    const first = await getFastSessionMessagesSince(session.id, 0);
    await expect(
      getFastSessionPrReviewOfferStatus(session.id, deliveryId),
    ).resolves.toBe('pending');

    await updateFastSessionPrReviewOfferStatus(
      session.id,
      [deliveryId],
      'dismissed',
    );
    const second = await getFastSessionMessagesSince(session.id, first.cursor);

    expect(second.messages).toHaveLength(1);
    expect(second.messages[0]?.payload).toMatchObject({
      prReviewAction: { deliveryId, status: 'dismissed' },
    });
    await expect(
      getFastSessionPrReviewOfferStatus(session.id, deliveryId),
    ).resolves.toBe('dismissed');
  });

  it('finds sessions for every deployment user', async () => {
    const owner = await userFactory.create();
    const participant = await userFactory.create();
    const bystander = await userFactory.create();
    const session = await createFastSession({
      userId: owner.id,
      conversationId: 'access-session',
      updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    });
    await createFastMessage({
      conversationId: session.id,
      eventId: 'turn-1:user',
      turnSeq: 0,
      role: 'user',
      eventType: 'roomote_runtime.user_prompt',
      metadata: { visibleInTranscript: true, userId: participant.id },
    });

    await expect(
      findAccessibleFastSession(
        { userId: owner.id, isAdmin: false },
        session.id,
      ),
    ).resolves.toMatchObject({ id: session.id, surface: 'slack' });
    await expect(
      findAccessibleFastSession(
        { userId: participant.id, isAdmin: false },
        session.id,
      ),
    ).resolves.toMatchObject({ id: session.id });
    await expect(
      findAccessibleFastSession(
        { userId: bystander.id, isAdmin: false },
        session.id,
      ),
    ).resolves.toMatchObject({ id: session.id });
  });

  it('keeps a partial newest turn when a single turn overflows the window', async () => {
    const owner = await userFactory.create();
    const session = await createFastSession({
      userId: owner.id,
      conversationId: 'giant-turn-session',
      updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    });
    // One turn with more visible events than the transcript window holds.
    const rows = Array.from({ length: 1010 }, (_, index) => ({
      conversationId: session.id,
      eventId: `event-${index}`,
      turnId: 'turn-0',
      turnSeq: index,
      ts: index + 1,
      eventType: 'roomote_runtime.assistant_message' as const,
      role: 'assistant' as const,
      contentBlocks: [{ type: 'text' as const, text: `event-${index}` }],
      metadata: { visibleInTranscript: true },
      payload: {},
      source: 'slack',
    }));
    await db.insert(fastAgentMessages).values(rows);

    const result = await getFastSessionById(
      { userId: owner.id, isAdmin: false },
      session.id,
    );

    expect(result?.hasOlderMessages).toBe(true);
    // The whole-turn trim must not empty the window; the newest events stay.
    expect(result?.messages.length).toBe(1000);
    expect(result?.messages.at(-1)?.eventId).toBe('event-1009');
  });
});
