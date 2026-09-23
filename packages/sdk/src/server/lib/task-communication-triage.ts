import {
  captureTaskCommunicationTriage,
  triageTaskCommunication,
  type FastAgentSurface,
  type TaskCommunicationTriageHint,
  type TaskCommunicationTriageState,
  type TaskCommunicationUpdate,
} from '@roomote/cloud-agents/server';
import {
  and,
  asc,
  db,
  desc,
  eq,
  fastAgentMessages,
  getSessionForFastConversation,
  inArray,
  isDeploymentExperimentEnabled,
  sql,
  taskMessages,
  tasks,
} from '@roomote/db/server';
import { getRedis, isSessionUserPresent } from '@roomote/redis';
import {
  ACP_ENVELOPE_EVENT_TYPES,
  extractAcpMessageText,
  extractVisibleAcpPromptText,
  isSystemInjectedAcpPromptText,
  type FastAgentParent,
  type TaskMessageContentBlock,
} from '@roomote/types';

/** A task relays at most once in this window unless it needs the user. */
const RELAY_MIN_GAP_MS = 2 * 60_000;
/** A human message this recent counts as the requester being present. */
const RECENT_HUMAN_PRESENCE_MS = 3 * 60_000;
const EXPERIMENT_CACHE_TTL_MS = 30_000;
const UNSHARED_UPDATES_MAX = 8;
const UNSHARED_UPDATES_TTL_SECONDS = 24 * 60 * 60;
const MAX_INSTRUCTIONS_CHARS = 1_200;
const MAX_CONTEXT_MESSAGES = 6;
const MAX_CONTEXT_CHARS = 800;

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

export type TaskActivityDigestItem = Extract<
  TaskCommunicationUpdate,
  { kind: 'task_activity' }
>['items'][number];

let experimentCache: { enabled: boolean; expiresAt: number } | null = null;

/** Cached because it is consulted for every persisted task envelope. */
export async function isTaskCommunicationTriageEnabled(): Promise<boolean> {
  const now = Date.now();
  if (experimentCache && experimentCache.expiresAt > now) {
    return experimentCache.enabled;
  }
  const enabled = await isDeploymentExperimentEnabled(
    'sessionTaskCommunicationTriage',
  ).catch(() => false);
  experimentCache = { enabled, expiresAt: now + EXPERIMENT_CACHE_TTL_MS };
  return enabled;
}

function textOf(row: {
  contentBlocks: TaskMessageContentBlock[];
  payload: unknown;
}): string | undefined {
  let text = extractAcpMessageText(row.contentBlocks, asRecord(row.payload));
  if (text && isSystemInjectedAcpPromptText(text)) {
    text = extractVisibleAcpPromptText(text);
  }
  return text?.trim() || undefined;
}

function silenceBucket(
  lastHeardAtMs: number | null,
): TaskCommunicationTriageState['silenceSinceRequesterLastHeard'] {
  if (lastHeardAtMs === null) return 'never_heard';
  const minutes = (Date.now() - lastHeardAtMs) / 60_000;
  if (minutes < 5) return 'under_5_minutes';
  if (minutes < 20) return '5_to_20_minutes';
  return 'over_20_minutes';
}

async function buildTriageState(params: {
  parent: FastAgentParent;
  surface: FastAgentSurface;
  requesterUserId: string | null;
  taskId: string;
  runId: number;
  update: TaskCommunicationUpdate;
}): Promise<TaskCommunicationTriageState> {
  const [task, taskPrompt, conversationRows, session] = await Promise.all([
    db.query.tasks.findFirst({
      where: eq(tasks.id, params.taskId),
      columns: { title: true },
    }),
    db.query.taskMessages.findFirst({
      where: and(
        eq(taskMessages.runId, params.runId),
        eq(taskMessages.eventType, ACP_ENVELOPE_EVENT_TYPES.UserPrompt),
      ),
      columns: { contentBlocks: true, payload: true },
      orderBy: [asc(taskMessages.ts)],
    }),
    db
      .select({
        ts: fastAgentMessages.ts,
        eventType: fastAgentMessages.eventType,
        contentBlocks: fastAgentMessages.contentBlocks,
        payload: fastAgentMessages.payload,
        metadata: fastAgentMessages.metadata,
      })
      .from(fastAgentMessages)
      .where(
        and(
          eq(fastAgentMessages.conversationId, params.parent.sessionId),
          inArray(fastAgentMessages.eventType, [
            ACP_ENVELOPE_EVENT_TYPES.UserPrompt,
            ACP_ENVELOPE_EVENT_TYPES.AssistantMessage,
          ]),
          sql`coalesce(${fastAgentMessages.metadata} ->> 'visibleInTranscript', 'true') <> 'false'`,
        ),
      )
      .orderBy(desc(fastAgentMessages.ts))
      .limit(40),
    params.surface === 'web' && params.requesterUserId
      ? getSessionForFastConversation(db, params.parent.sessionId)
      : Promise.resolve(null),
  ]);

  const asked: string[] = [];
  const told: string[] = [];
  let lastHeardAtMs: number | null = null;
  let lastHumanAtMs: number | null = null;
  for (const row of [...conversationRows].reverse()) {
    const text = textOf(row);
    if (!text) continue;
    const metadata = asRecord(row.metadata);
    if (row.eventType === ACP_ENVELOPE_EVENT_TYPES.UserPrompt) {
      if (metadata?.turnSource !== 'human') continue;
      asked.push(truncate(text, MAX_CONTEXT_CHARS));
      lastHumanAtMs = row.ts;
    } else {
      told.push(truncate(text, MAX_CONTEXT_CHARS));
      lastHeardAtMs = row.ts;
    }
  }
  const instructions = taskPrompt ? textOf(taskPrompt) : undefined;

  const present =
    session && params.requesterUserId
      ? await isSessionUserPresent({
          sessionId: session.id,
          userId: params.requesterUserId,
        }).catch(() => false)
      : false;

  return {
    surface: params.surface,
    requesterIsPresent:
      present ||
      (lastHumanAtMs !== null &&
        Date.now() - lastHumanAtMs < RECENT_HUMAN_PRESENCE_MS),
    silenceSinceRequesterLastHeard: silenceBucket(lastHeardAtMs),
    whatTheRequesterAskedFor: [
      ...(instructions ? [truncate(instructions, MAX_INSTRUCTIONS_CHARS)] : []),
      ...asked.slice(-MAX_CONTEXT_MESSAGES),
    ],
    whatTheRequesterWasAlreadyTold: told.slice(-MAX_CONTEXT_MESSAGES),
    task: { title: task?.title ?? null },
    update: params.update,
  };
}

function unsharedUpdatesKey(runId: number) {
  return `session-task-unshared:${runId}`;
}

function summarizeUpdate(update: TaskCommunicationUpdate): string {
  return truncate(
    update.kind === 'task_report'
      ? update.text
      : update.items
          .filter((item) => item.kind !== 'tools')
          .map((item) => item.text)
          .join('\n'),
    600,
  );
}

async function rememberUnsharedUpdate(
  runId: number,
  update: TaskCommunicationUpdate,
): Promise<void> {
  const summary = summarizeUpdate(update);
  if (!summary) return;
  const key = unsharedUpdatesKey(runId);
  await getRedis()
    .multi()
    .rpush(key, summary)
    .ltrim(key, -UNSHARED_UPDATES_MAX, -1)
    .expire(key, UNSHARED_UPDATES_TTL_SECONDS)
    .exec()
    .catch(() => {});
}

/**
 * Updates triage kept from the user, for the closeout to fold in. Read
 * without clearing so a retried settle delivery sees the same list; the key
 * expires on its own.
 */
export async function listUnsharedTaskUpdates(
  runId: number,
): Promise<string[]> {
  if (!(await isTaskCommunicationTriageEnabled())) return [];
  return getRedis()
    .lrange(unsharedUpdatesKey(runId), 0, -1)
    .catch(() => []);
}

function closeoutRelayedKey(runId: number) {
  return `session-task-closeout-relayed:${runId}`;
}

/**
 * Whether triage already sent the task's own closeout to the user, so the
 * settle turn only needs to speak when it adds something new.
 */
export async function wasTaskCloseoutRelayed(runId: number): Promise<boolean> {
  if (!(await isTaskCommunicationTriageEnabled())) return false;
  return (
    (await getRedis()
      .exists(closeoutRelayedKey(runId))
      .catch(() => 0)) > 0
  );
}

/** Claim the per-task relay slot; false when the task relayed recently. */
async function claimRelaySlot(runId: number, force: boolean): Promise<boolean> {
  const key = `session-task-relay:${runId}`;
  const redis = getRedis();
  if (force) {
    await redis.set(key, '1', 'PX', RELAY_MIN_GAP_MS).catch(() => {});
    return true;
  }
  const claimed = await redis
    .set(key, '1', 'PX', RELAY_MIN_GAP_MS, 'NX')
    .catch(() => 'OK');
  return claimed === 'OK';
}

type TaskCommunicationGate =
  | { kind: 'deliver'; hint?: TaskCommunicationTriageHint }
  | { kind: 'skip' };

/**
 * Decide whether a delegated task's update should become a parent turn.
 * Explicit reports keep today's behavior whenever the judgment model cannot
 * answer; activity digests only ever reach the parent through triage.
 */
export async function gateDelegatedTaskCommunication(params: {
  parent: FastAgentParent;
  surface: FastAgentSurface;
  requesterUserId: string | null;
  telemetryUserId: string;
  event:
    | {
        type: 'child_message';
        taskId: string;
        runId: number;
        purpose: 'ack' | 'progress' | 'closeout' | 'clarification';
        message: string;
      }
    | {
        type: 'task_activity';
        taskId: string;
        runId: number;
        items: TaskActivityDigestItem[];
      };
}): Promise<TaskCommunicationGate> {
  const { event } = params;
  const fallback: TaskCommunicationGate =
    event.type === 'child_message' ? { kind: 'deliver' } : { kind: 'skip' };
  if (!(await isTaskCommunicationTriageEnabled())) return fallback;

  const update: TaskCommunicationUpdate =
    event.type === 'child_message'
      ? { kind: 'task_report', purpose: event.purpose, text: event.message }
      : { kind: 'task_activity', items: event.items };
  const telemetry = {
    userId: params.telemetryUserId,
    sessionId: params.parent.sessionId,
    eventType: event.type,
    surface: params.surface,
  };

  let result: Awaited<ReturnType<typeof triageTaskCommunication>>;
  try {
    const state = await buildTriageState({
      parent: params.parent,
      surface: params.surface,
      requesterUserId: params.requesterUserId,
      taskId: event.taskId,
      runId: event.runId,
      update,
    });
    result = await triageTaskCommunication(state);
  } catch (error) {
    console.warn(
      `[TaskCommunicationTriage] Judgment failed for run ${event.runId}; using fallback: ${error instanceof Error ? error.message : String(error)}`,
    );
    captureTaskCommunicationTriage({
      ...telemetry,
      outcome: 'judgment_failed',
    });
    return fallback;
  }
  if (!result) {
    captureTaskCommunicationTriage({
      ...telemetry,
      outcome: 'judgment_unconfigured',
    });
    return fallback;
  }

  const { decision, reason, signals, latencyMs } = result;
  const capture = (
    outcome: Parameters<typeof captureTaskCommunicationTriage>[0]['outcome'],
  ) =>
    captureTaskCommunicationTriage({
      ...telemetry,
      outcome,
      reason,
      signals,
      latencyMs,
    });
  console.info(
    `[TaskCommunicationTriage] run=${event.runId} event=${event.type} decision=${decision} reason=${reason} latencyMs=${Math.round(latencyMs)} ${Object.entries(
      signals,
    )
      .map(([signal, value]) => `${signal}=${value.toFixed(2)}`)
      .join(' ')}`,
  );

  switch (decision) {
    case 'redirect':
      capture(decision);
      return { kind: 'deliver', hint: { decision, reason } };
    case 'relay': {
      if (!(await claimRelaySlot(event.runId, reason === 'needs_user'))) {
        capture('rate_limited');
        await rememberUnsharedUpdate(event.runId, update);
        return { kind: 'skip' };
      }
      capture(decision);
      if (event.type === 'child_message' && event.purpose === 'closeout') {
        await getRedis()
          .set(
            closeoutRelayedKey(event.runId),
            '1',
            'EX',
            UNSHARED_UPDATES_TTL_SECONDS,
          )
          .catch(() => {});
      }
      return { kind: 'deliver', hint: { decision, reason } };
    }
    case 'uncertain':
      capture(decision);
      if (event.type === 'child_message') {
        return { kind: 'deliver', hint: { decision, reason } };
      }
      await rememberUnsharedUpdate(event.runId, update);
      return { kind: 'skip' };
    case 'quiet':
      capture(decision);
      // Routine narration and repeats add nothing to a closeout; only a
      // held-back milestone is worth folding in later.
      if (reason === 'milestone_can_wait') {
        await rememberUnsharedUpdate(event.runId, update);
      }
      return { kind: 'skip' };
  }
}
