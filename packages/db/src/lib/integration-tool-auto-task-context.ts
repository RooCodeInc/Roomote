import { and, desc, eq, gt, lt, lte, sql } from 'drizzle-orm';

import {
  ACP_ENVELOPE_EVENT_TYPES,
  PROVIDER_RETRY_NOTICE_PAYLOAD_KEY,
  TERMINAL_PROVIDER_ERROR_PAYLOAD_KEY,
  asRecord,
  extractAcpMessageText,
  toIntegrationToolUserRequest,
  type TaskMessageContentBlock,
} from '@roomote/types';

import { db } from '../db';
import {
  fastAgentMessages,
  sessions,
  sessionTasks,
  taskMessages,
  tasks,
} from '../schema';

const REQUEST_HISTORY_LIMIT = 20;
const REPLIED_TO_MESSAGE_LIMIT = 3;
const RECENT_TOOL_RESULT_LIMIT = 30;
const RECENT_TOOL_RESULT_OUTPUT_LENGTH = 8_000;
const RECENT_TOOL_RESULT_ARGUMENTS_LENGTH = 2_000;
const READ_CONTENT_RESULT_LIMIT = 40;
const READ_CONTENT_RESULT_OUTPUT_LENGTH = 20_000;
const DELEGATION_PROMPT_LENGTH = 6_000;
/** Roomote's own tools, as a task's agent names their server. */
const ROOMOTE_SERVER_NAME = 'roomote';

/**
 * What Auto is shown about a task's tool call, matching what it is shown
 * about a call made by the session's own agent.
 */
export type TaskIntegrationToolAutoContext = {
  /** The latest thing a person asked for in the session or the task. */
  userRequest?: string;
  /** What people asked for in the session and the task, oldest first. */
  recentUserMessages: string[];
  /** What the agent said before the latest request, such as a plan. */
  agentMessageRepliedTo?: string;
  /** Results of integration tools the task's agent ran, oldest first. */
  recentToolResults: Array<{
    tool: string;
    arguments?: unknown;
    output: string;
  }>;
  /** What the task's agent read since its latest prompt. */
  readContent?: string;
};

type Request = {
  ts: number;
  text: string;
  from: 'session' | 'task' | 'launch';
  eventId?: string;
};

function textOf(
  contentBlocks: TaskMessageContentBlock[],
  payload?: unknown,
): string {
  return (
    extractAcpMessageText(contentBlocks, asRecord(payload) ?? null) ?? ''
  ).trim();
}

/**
 * The same rows the session's own agent is judged against: prompts a person
 * sent to the session, stamped by the server. Platform events, reactions, and
 * hidden rows are not requests.
 */
async function listSessionHumanPrompts(
  conversationId: string,
): Promise<Request[]> {
  const rows = await db
    .select({
      ts: fastAgentMessages.ts,
      eventId: fastAgentMessages.eventId,
      contentBlocks: fastAgentMessages.contentBlocks,
    })
    .from(fastAgentMessages)
    .where(
      and(
        eq(fastAgentMessages.conversationId, conversationId),
        eq(fastAgentMessages.eventType, ACP_ENVELOPE_EVENT_TYPES.UserPrompt),
        eq(fastAgentMessages.role, 'user'),
        sql`${fastAgentMessages.metadata}->>'turnSource' = 'human'`,
        sql`coalesce(${fastAgentMessages.metadata}->>'inputKind', 'message') <> 'reaction'`,
        sql`coalesce(${fastAgentMessages.metadata}->>'visibleInTranscript', 'true') <> 'false'`,
      ),
    )
    .orderBy(desc(fastAgentMessages.ts), desc(fastAgentMessages.turnSeq))
    .limit(REQUEST_HISTORY_LIMIT);
  return rows.flatMap((row) => {
    const text = textOf(row.contentBlocks);
    return text
      ? [{ ts: row.ts, text, from: 'session' as const, eventId: row.eventId }]
      : [];
  });
}

/**
 * Prompts a person sent to the task itself: shown in its transcript and
 * carrying the sender. The task's wrapped first prompt and the prompts the
 * platform or the harness sends (setup, recovery, reminders) are hidden or
 * have no sender, so they never count as a request. These rows are recorded
 * by the task's own worker, unlike the session's.
 */
async function listTaskHumanPrompts(taskId: string): Promise<Request[]> {
  const rows = await db
    .select({
      ts: taskMessages.ts,
      contentBlocks: taskMessages.contentBlocks,
      payload: taskMessages.payload,
    })
    .from(taskMessages)
    .where(
      and(
        eq(taskMessages.taskId, taskId),
        eq(taskMessages.eventType, ACP_ENVELOPE_EVENT_TYPES.UserPrompt),
        sql`coalesce(${taskMessages.metadata}->>'visibleInTranscript', 'true') <> 'false'`,
        sql`${taskMessages.metadata}->>'userId' is not null`,
      ),
    )
    .orderBy(desc(taskMessages.ts), desc(taskMessages.createdAt))
    .limit(REQUEST_HISTORY_LIMIT);
  return rows.flatMap((row) => {
    const text = toIntegrationToolUserRequest(
      textOf(row.contentBlocks, row.payload),
    );
    return text ? [{ ts: row.ts, text, from: 'task' as const }] : [];
  });
}

/** The session agent's visible replies in a window, oldest first. */
async function findSessionReplies(input: {
  conversationId: string;
  afterTs: number;
  untilTs: number;
}): Promise<string | undefined> {
  const rows = await db
    .select({ contentBlocks: fastAgentMessages.contentBlocks })
    .from(fastAgentMessages)
    .where(
      and(
        eq(fastAgentMessages.conversationId, input.conversationId),
        gt(fastAgentMessages.ts, input.afterTs),
        lte(fastAgentMessages.ts, input.untilTs),
        eq(
          fastAgentMessages.eventType,
          ACP_ENVELOPE_EVENT_TYPES.AssistantMessage,
        ),
        eq(fastAgentMessages.role, 'assistant'),
        sql`coalesce(${fastAgentMessages.metadata}->>'visibleInTranscript', 'true') <> 'false'`,
        sql`coalesce(${fastAgentMessages.metadata}->>'inferenceRetryNotice', 'false') <> 'true'`,
      ),
    )
    .orderBy(desc(fastAgentMessages.ts), desc(fastAgentMessages.turnSeq))
    .limit(REPLIED_TO_MESSAGE_LIMIT);
  const text = rows
    .reverse()
    .map((row) => textOf(row.contentBlocks))
    .filter(Boolean)
    .join('\n\n');
  return text || undefined;
}

/** The task agent's visible replies in a window, oldest first. */
async function findTaskReplies(input: {
  taskId: string;
  afterTs: number;
  beforeTs: number;
}): Promise<string | undefined> {
  const payload = taskMessages.payload;
  const rows = await db
    .select({
      contentBlocks: taskMessages.contentBlocks,
      payload: taskMessages.payload,
    })
    .from(taskMessages)
    .where(
      and(
        eq(taskMessages.taskId, input.taskId),
        gt(taskMessages.ts, input.afterTs),
        lt(taskMessages.ts, input.beforeTs),
        eq(taskMessages.eventType, ACP_ENVELOPE_EVENT_TYPES.AssistantMessage),
        sql`coalesce(${taskMessages.metadata}->>'visibleInTranscript', 'true') <> 'false'`,
        // Retry and provider-error notices are not something the agent said.
        sql`not (${payload} ? ${PROVIDER_RETRY_NOTICE_PAYLOAD_KEY})`,
        sql`not (${payload} ? ${TERMINAL_PROVIDER_ERROR_PAYLOAD_KEY})`,
      ),
    )
    .orderBy(desc(taskMessages.ts), desc(taskMessages.createdAt))
    .limit(REPLIED_TO_MESSAGE_LIMIT);
  const text = rows
    .reverse()
    .map((row) => textOf(row.contentBlocks, row.payload))
    .filter(Boolean)
    .join('\n\n');
  return text || undefined;
}

/**
 * Results of the integration tools the task's agent ran most recently,
 * oldest first. Auto reads them to tell what an identifier in a paused call
 * refers to. Unfinished calls and Roomote's own tools are skipped, each
 * output is cut to its head in the query, and oversized arguments are left
 * out, so one call never loads more than a bounded amount of text.
 */
async function findRecentTaskToolResults(
  taskId: string,
): Promise<TaskIntegrationToolAutoContext['recentToolResults']> {
  const payload = taskMessages.payload;
  const rows = await db
    .select({
      toolName: sql<
        string | null
      >`coalesce(${payload}->>'mcpToolName', ${payload}->>'toolName')`,
      serverName: sql<
        string | null
      >`coalesce(${payload}->>'mcpServerName', ${payload}->>'serverName')`,
      arguments: sql<unknown>`case when length((${payload}->'rawInput')::text) <= ${RECENT_TOOL_RESULT_ARGUMENTS_LENGTH} then ${payload}->'rawInput' end`,
      output: sql<
        string | null
      >`left(${payload}->>'output', ${RECENT_TOOL_RESULT_OUTPUT_LENGTH})`,
    })
    .from(taskMessages)
    .where(
      and(
        eq(taskMessages.taskId, taskId),
        eq(taskMessages.eventType, ACP_ENVELOPE_EVENT_TYPES.ToolResult),
        sql`${payload}->>'status' = 'completed'`,
        sql`${payload}->>'isMcp' = 'true'`,
        sql`coalesce(${payload}->>'mcpServerName', '') <> ${ROOMOTE_SERVER_NAME}`,
      ),
    )
    .orderBy(desc(taskMessages.ts), desc(taskMessages.createdAt))
    .limit(RECENT_TOOL_RESULT_LIMIT);
  return rows.reverse().flatMap((row) => {
    if (!row.toolName || !row.output?.trim()) return [];
    return [
      {
        tool: row.serverName
          ? `${row.serverName}.${row.toolName}`
          : row.toolName,
        ...(row.arguments === null || row.arguments === undefined
          ? {}
          : { arguments: row.arguments }),
        output: row.output,
      },
    ];
  });
}

/**
 * What the task's agent read since its latest prompt: the output of every
 * tool it finished, of any kind, oldest first. Auto reads it to tell whether
 * a call carries out an instruction planted in that content.
 */
async function findTaskReadContent(
  taskId: string,
): Promise<string | undefined> {
  const payload = taskMessages.payload;
  const [latestPrompt] = await db
    .select({ ts: taskMessages.ts })
    .from(taskMessages)
    .where(
      and(
        eq(taskMessages.taskId, taskId),
        eq(taskMessages.eventType, ACP_ENVELOPE_EVENT_TYPES.UserPrompt),
      ),
    )
    .orderBy(desc(taskMessages.ts))
    .limit(1);
  const rows = await db
    .select({
      output: sql<
        string | null
      >`left(${payload}->>'output', ${READ_CONTENT_RESULT_OUTPUT_LENGTH})`,
    })
    .from(taskMessages)
    .where(
      and(
        eq(taskMessages.taskId, taskId),
        gt(taskMessages.ts, latestPrompt?.ts ?? 0),
        eq(taskMessages.eventType, ACP_ENVELOPE_EVENT_TYPES.ToolResult),
        sql`${payload}->>'status' = 'completed'`,
      ),
    )
    .orderBy(desc(taskMessages.ts), desc(taskMessages.createdAt))
    .limit(READ_CONTENT_RESULT_LIMIT);
  const text = rows
    .reverse()
    .map((row) => row.output?.trim() ?? '')
    .filter(Boolean)
    .join('\n\n');
  return text || undefined;
}

/**
 * Whether the session's own agent launched this task. A task reads its
 * session's other tasks the way the session's agent does.
 */
export async function isSessionDelegatedTask(
  sessionId: string,
  taskId: string,
): Promise<boolean> {
  const [association] = await db
    .select({ taskId: sessionTasks.taskId })
    .from(sessionTasks)
    .where(
      and(
        eq(sessionTasks.sessionId, sessionId),
        eq(sessionTasks.taskId, taskId),
        eq(sessionTasks.origin, 'fast_delegation'),
      ),
    )
    .limit(1);
  return association !== undefined;
}

/**
 * Build the context Auto judges a task's tool call against, from what the
 * server holds about the task and its session.
 *
 * Requests come from three places, merged by time: prompts people sent to
 * the session, prompts people sent to the task, and the prompt the task was
 * launched with when a person or an automation launched it. A task the
 * session's agent launched was given its instructions by that agent, so they
 * are not a request: they are shown as something the agent did, and the call
 * is judged against what people asked the session for.
 *
 * The session's rows are written by the server. The task's rows (prompts sent
 * to it, its replies, its tool results) are recorded by the task's worker.
 */
export async function resolveTaskIntegrationToolAutoContext(input: {
  taskId: string;
  sessionId: string;
}): Promise<TaskIntegrationToolAutoContext> {
  const [link] = await db
    .select({
      origin: sessionTasks.origin,
      fastConversationId: sessions.fastConversationId,
      prompt: tasks.prompt,
      createdAt: tasks.createdAt,
    })
    .from(sessionTasks)
    .innerJoin(sessions, eq(sessions.id, sessionTasks.sessionId))
    .innerJoin(tasks, eq(tasks.id, sessionTasks.taskId))
    .where(
      and(
        eq(sessionTasks.taskId, input.taskId),
        eq(sessionTasks.sessionId, input.sessionId),
      ),
    )
    .limit(1);
  const conversationId = link?.fastConversationId ?? null;
  const delegated = link?.origin === 'fast_delegation';
  const launchPrompt = toIntegrationToolUserRequest(link?.prompt);

  const [sessionPrompts, taskPrompts, taskToolResults, readContent] =
    await Promise.all([
      conversationId ? listSessionHumanPrompts(conversationId) : [],
      listTaskHumanPrompts(input.taskId),
      findRecentTaskToolResults(input.taskId),
      findTaskReadContent(input.taskId),
    ]);

  const requests: Request[] = [
    ...sessionPrompts,
    ...taskPrompts,
    ...(launchPrompt && link && !delegated
      ? [
          {
            ts: link.createdAt.getTime(),
            text: launchPrompt,
            from: 'launch' as const,
          },
        ]
      : []),
  ].sort((left, right) => left.ts - right.ts);
  const latest = requests.at(-1);

  let agentMessageRepliedTo: string | undefined;
  if (latest?.from === 'session' && conversationId) {
    // Newest first: the one before the latest is the previous request.
    const previous = sessionPrompts.find(
      (prompt) => prompt.eventId !== latest.eventId && prompt.ts < latest.ts,
    );
    agentMessageRepliedTo = await findSessionReplies({
      conversationId,
      afterTs: previous?.ts ?? 0,
      untilTs: latest.ts,
    });
  } else if (latest?.from === 'task') {
    const previous = taskPrompts.find((prompt) => prompt.ts < latest.ts);
    agentMessageRepliedTo = await findTaskReplies({
      taskId: input.taskId,
      afterTs: previous?.ts ?? 0,
      beforeTs: latest.ts,
    });
  }

  return {
    ...(latest ? { userRequest: latest.text } : {}),
    recentUserMessages: requests.map((request) => request.text),
    ...(agentMessageRepliedTo ? { agentMessageRepliedTo } : {}),
    recentToolResults: [
      ...(delegated && launchPrompt
        ? [
            {
              tool: `${ROOMOTE_SERVER_NAME}.launch_task`,
              output: `The session's agent launched this task with these instructions:\n${launchPrompt.slice(0, DELEGATION_PROMPT_LENGTH)}`,
            },
          ]
        : []),
      ...taskToolResults,
    ],
    ...(readContent ? { readContent } : {}),
  };
}
