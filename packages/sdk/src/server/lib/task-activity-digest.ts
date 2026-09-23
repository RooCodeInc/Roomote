import { Queue } from 'bullmq';

import {
  and,
  asc,
  db,
  desc,
  eq,
  fastAgentParentEvents,
  gt,
  inArray,
  sql,
  taskMessages,
  taskRuns,
} from '@roomote/db/server';
import { getRedis } from '@roomote/redis';
import {
  ACP_ENVELOPE_EVENT_TYPES,
  exitedRunStatuses,
  extractAcpMessageText,
  getFastAgentParentFromPayload,
  isPrReviewRun,
  RunStatus,
  type FastAgentParent,
  type TaskMessageContentBlock,
} from '@roomote/types';

import { enqueueFastAgentParentEvent } from './fast-agent-parent-event-queue';
import {
  isTaskCommunicationTriageEnabled,
  type TaskActivityDigestItem,
} from './task-communication-triage';

export const TASK_ACTIVITY_DIGEST_QUEUE_NAME = 'task-activity-digests';

/** Activity is gathered for this long before the Session sees a digest. */
const DIGEST_WINDOW_MS = 60_000;
/** Tool use with no narration only becomes a digest after this long. */
const TOOLS_ONLY_DIGEST_MIN_GAP_MS = 5 * 60_000;
const PARENT_CACHE_TTL_MS = 5 * 60_000;
const PARENT_CACHE_MAX_ENTRIES = 2_000;
const MAX_ITEM_CHARS = 1_200;
const MAX_ASSISTANT_MESSAGES = 4;

const DIGEST_EVENT_TYPES = [
  ACP_ENVELOPE_EVENT_TYPES.AssistantMessage,
  ACP_ENVELOPE_EVENT_TYPES.Plan,
  ACP_ENVELOPE_EVENT_TYPES.RequestUserInput,
  ACP_ENVELOPE_EVENT_TYPES.ToolCall,
] as const;
const QUESTION_DIGEST_EVENT_TYPES = [
  ACP_ENVELOPE_EVENT_TYPES.RequestUserInput,
] as const;
const DIGEST_EVENT_TYPE_SET = new Set<string>(DIGEST_EVENT_TYPES);
type TaskActivityDigestEventType = (typeof DIGEST_EVENT_TYPES)[number];

export function shouldScheduleTaskActivityDigestFor(
  eventType: string,
  triageEnabled: boolean,
): boolean {
  return (
    DIGEST_EVENT_TYPE_SET.has(eventType) &&
    (triageEnabled || eventType === ACP_ENVELOPE_EVENT_TYPES.RequestUserInput)
  );
}

export function getTaskActivityDigestEventTypes(
  triageEnabled: boolean,
): readonly TaskActivityDigestEventType[] {
  return triageEnabled ? DIGEST_EVENT_TYPES : QUESTION_DIGEST_EVENT_TYPES;
}

/** Tools whose content already reaches the Session another way. */
const DIGEST_IGNORED_TOOLS = new Set([
  'report_to_parent_session',
  'relay_fast_agent_child_chat_reply',
  'request_user_input',
  'save_task_memory',
]);

const EXITED_RUN_STATUSES = new Set<RunStatus>(exitedRunStatuses);

function truncate(text: string, maxChars: number): string {
  const trimmed = text.trim();
  return trimmed.length > maxChars
    ? `${trimmed.slice(0, maxChars - 1).trimEnd()}…`
    : trimmed;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export type TaskActivityDigestJob = { runId: number };

let digestQueue: Queue<TaskActivityDigestJob> | null = null;

function getDigestQueue() {
  digestQueue ??= new Queue<TaskActivityDigestJob>(
    TASK_ACTIVITY_DIGEST_QUEUE_NAME,
    {
      connection: getRedis(),
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 5_000 },
        removeOnComplete: true,
        removeOnFail: true,
      },
    },
  );
  return digestQueue;
}

const parentRunCache = new Map<
  number,
  { hasParent: boolean; expiresAt: number }
>();

async function runReportsToParentSession(runId: number): Promise<boolean> {
  const now = Date.now();
  const cached = parentRunCache.get(runId);
  if (cached && cached.expiresAt > now) {
    return cached.hasParent;
  }
  const run = await db.query.taskRuns.findFirst({
    where: eq(taskRuns.id, runId),
    columns: { payload: true, payloadKind: true },
  });
  const hasParent = Boolean(
    run && getFastAgentParentFromPayload(run.payload) && !isPrReviewRun(run),
  );
  if (parentRunCache.size >= PARENT_CACHE_MAX_ENTRIES) {
    parentRunCache.clear();
  }
  parentRunCache.set(runId, {
    hasParent,
    expiresAt: now + PARENT_CACHE_TTL_MS,
  });
  return hasParent;
}

/**
 * Schedule a digest of a delegated task's recent activity for its parent
 * Session. Activity is read back from `task_messages` when the digest runs,
 * so a lost wakeup only delays the next digest. A question for the user is
 * flushed at once; everything else is gathered for one window.
 */
export async function maybeScheduleTaskActivityDigest(input: {
  runId: number;
  envelope: { eventType: string; ts: number };
}): Promise<void> {
  const isQuestion =
    input.envelope.eventType === ACP_ENVELOPE_EVENT_TYPES.RequestUserInput;
  const triageEnabled = isQuestion
    ? false
    : await isTaskCommunicationTriageEnabled();
  if (
    !shouldScheduleTaskActivityDigestFor(
      input.envelope.eventType,
      triageEnabled,
    )
  ) {
    return;
  }
  if (!(await runReportsToParentSession(input.runId))) return;

  const urgent = isQuestion;
  const now = Date.now();
  await getDigestQueue().add(
    'flush',
    { runId: input.runId },
    urgent
      ? { jobId: `digest-${input.runId}-question-${input.envelope.ts}` }
      : {
          jobId: `digest-${input.runId}-${Math.floor(now / DIGEST_WINDOW_MS)}`,
          delay: DIGEST_WINDOW_MS,
        },
  );
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function formatPlan(payload: Record<string, unknown> | null): string | null {
  const entries = Array.isArray(payload?.entries) ? payload.entries : [];
  const lines = entries.flatMap((entry) => {
    const record = asRecord(entry);
    const content = asString(record?.content);
    if (!content) return [];
    const status = asString(record?.status) ?? 'pending';
    const marker =
      status === 'completed'
        ? '[done]'
        : status === 'in_progress'
          ? '[doing]'
          : '[todo]';
    return [`${marker} ${content}`];
  });
  return lines.length ? truncate(lines.join('\n'), MAX_ITEM_CHARS) : null;
}

function formatQuestion(
  payload: Record<string, unknown> | null,
): string | null {
  const questions = Array.isArray(payload?.questions) ? payload.questions : [];
  const lines = questions.flatMap((question) => {
    const record = asRecord(question);
    const text =
      asString(record?.question) ?? asString(record?.header) ?? undefined;
    if (!text) return [];
    const options = (Array.isArray(record?.options) ? record.options : [])
      .map((option) => asString(asRecord(option)?.label))
      .filter((label): label is string => Boolean(label));
    return [options.length ? `${text} (options: ${options.join(', ')})` : text];
  });
  return lines.length ? truncate(lines.join('\n'), MAX_ITEM_CHARS) : null;
}

/**
 * Condense persisted task activity into what the Session needs to judge it:
 * the task's own narration, its latest plan, any question it asked, and a
 * compact list of the tools it reached for.
 */
export function buildTaskActivityDigest(
  rows: Array<{
    eventType: string;
    contentBlocks: TaskMessageContentBlock[];
    payload: unknown;
  }>,
): { items: TaskActivityDigestItem[]; toolsOnly: boolean } | null {
  const messages: string[] = [];
  const questions: string[] = [];
  const tools = new Set<string>();
  let plan: string | null = null;

  for (const row of rows) {
    const payload = asRecord(row.payload);
    switch (row.eventType) {
      case ACP_ENVELOPE_EVENT_TYPES.AssistantMessage: {
        const text = extractAcpMessageText(row.contentBlocks, payload);
        // Provider retry notices are machinery, not the task's narration.
        if (text?.trim() && !text.trimStart().startsWith('Provider error:')) {
          messages.push(truncate(text, MAX_ITEM_CHARS));
        }
        break;
      }
      case ACP_ENVELOPE_EVENT_TYPES.Plan:
        plan = formatPlan(payload) ?? plan;
        break;
      case ACP_ENVELOPE_EVENT_TYPES.RequestUserInput: {
        const question = formatQuestion(payload);
        if (question) questions.push(question);
        break;
      }
      case ACP_ENVELOPE_EVENT_TYPES.ToolCall: {
        const toolName = asString(payload?.toolName);
        if (toolName && DIGEST_IGNORED_TOOLS.has(toolName)) break;
        const title = asString(payload?.title) ?? toolName;
        if (title) tools.add(truncate(title, 120));
        break;
      }
    }
  }

  const items: TaskActivityDigestItem[] = [
    ...messages
      .slice(-MAX_ASSISTANT_MESSAGES)
      .map((text) => ({ kind: 'assistant_message' as const, text })),
    ...(plan ? [{ kind: 'plan' as const, text: plan }] : []),
    ...questions.map((text) => ({ kind: 'question' as const, text })),
  ];
  const toolsOnly = items.length === 0;
  if (tools.size > 0) {
    const titles = [...tools];
    const shown = titles.slice(-12);
    items.push({
      kind: 'tools',
      text:
        titles.length > shown.length
          ? `${shown.join('; ')} (+${titles.length - shown.length} earlier)`
          : shown.join('; '),
    });
  }
  return items.length ? { items, toolsOnly } : null;
}

async function findLastDigest(
  parent: FastAgentParent,
  runId: number,
): Promise<{ throughTs: number; createdAt: Date } | null> {
  const [row] = await db
    .select({
      event: fastAgentParentEvents.event,
      createdAt: fastAgentParentEvents.createdAt,
    })
    .from(fastAgentParentEvents)
    .where(
      and(
        eq(fastAgentParentEvents.conversationId, parent.sessionId),
        sql`${fastAgentParentEvents.event} ->> 'type' = 'task_activity'`,
        sql`(${fastAgentParentEvents.event} ->> 'runId')::integer = ${runId}`,
      ),
    )
    .orderBy(desc(fastAgentParentEvents.createdAt))
    .limit(1);
  const throughTs = row ? Number(row.event.throughTs) : NaN;
  return row && Number.isFinite(throughTs)
    ? { throughTs, createdAt: row.createdAt }
    : null;
}

/** Turn a run's activity since its previous digest into a parent event. */
export async function flushTaskActivityDigest(
  job: TaskActivityDigestJob,
): Promise<void> {
  const triageEnabled = await isTaskCommunicationTriageEnabled();

  const run = await db.query.taskRuns.findFirst({
    where: eq(taskRuns.id, job.runId),
    columns: {
      id: true,
      taskId: true,
      status: true,
      actingUserId: true,
      payload: true,
      payloadKind: true,
      createdAt: true,
    },
  });
  const parent = getFastAgentParentFromPayload(run?.payload);
  if (!run || !parent || isPrReviewRun(run)) return;
  // The settle event carries whatever the run did last; an idle run has
  // settled too and only resumes through a new turn.
  if (EXITED_RUN_STATUSES.has(run.status) || run.status === RunStatus.Idle) {
    return;
  }

  const lastDigest = await findLastDigest(parent, run.id);
  const rows = await db
    .select({
      ts: taskMessages.ts,
      eventType: taskMessages.eventType,
      contentBlocks: taskMessages.contentBlocks,
      payload: taskMessages.payload,
    })
    .from(taskMessages)
    .where(
      and(
        eq(taskMessages.runId, run.id),
        inArray(
          taskMessages.eventType,
          getTaskActivityDigestEventTypes(triageEnabled),
        ),
        ...(lastDigest ? [gt(taskMessages.ts, lastDigest.throughTs)] : []),
      ),
    )
    .orderBy(asc(taskMessages.ts))
    .limit(200);
  if (rows.length === 0) return;

  const digest = buildTaskActivityDigest(rows);
  if (!digest) return;
  // Heads-down tool use is not news. Leave it unread so it rides along with
  // the next narration, and surface it alone only after a long stretch.
  const sinceLastDigestMs =
    Date.now() - (lastDigest?.createdAt ?? run.createdAt).getTime();
  if (digest.toolsOnly && sinceLastDigestMs < TOOLS_ONLY_DIGEST_MIN_GAP_MS) {
    return;
  }

  await enqueueFastAgentParentEvent({
    parent,
    event: {
      type: 'task_activity',
      taskId: run.taskId,
      runId: run.id,
      ...(run.actingUserId ? { actingUserId: run.actingUserId } : {}),
      throughTs: rows[rows.length - 1]!.ts,
      items: digest.items,
    },
  });
}
