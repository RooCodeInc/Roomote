import {
  and,
  admitSessionWakeup,
  cancelSessionWakeup,
  db,
  desc,
  deploymentSettings,
  eq,
  fastAgentMessages,
  getSessionWakeupById,
  listSessionWakeups,
  type SessionWakeup,
} from '@roomote/db/server';
import {
  ACP_ENVELOPE_EVENT_TYPES,
  MAX_ACTIVE_SESSION_WAKEUPS,
  isSessionWakeupRecurring,
  parseAcpVoiceCallPayload,
  type ManageWakeupsInput,
  type SessionWakeupReportPolicy,
  type SessionWakeupSummary,
} from '@roomote/types';

import { enqueueSessionWakeupFireBestEffort } from './queue';
import { parseSessionWakeupSchedule } from './parse';
import {
  SessionWakeupValidationError,
  describeSessionWakeupSchedule,
  normalizeSessionWakeupTimeZone,
} from './schedule';

const DEFAULT_DEPLOYMENT_SETTINGS_ID = 'default';
const OWN_TASK_FOLLOW_THROUGH_WAKEUP = {
  name: 'Follow through on session tasks',
  prompt:
    'Run the Own Coding Task Follow-Through session check for all tasks in this conversation. Follow that system policy exactly, including inspection, reporting, correction, stopping, and rearming.',
  reportPolicy: 'only_when_notable' as const,
};
const OWN_TASK_FOLLOW_THROUGH_SCHEDULE = {
  voice: 'in 30s',
  text: 'in 10m',
} as const;

function isOwnTaskFollowThroughInput(input: CreateSessionWakeupInput): boolean {
  return (
    input.internal === true &&
    input.name.trim().replace(/\s+/g, ' ') ===
      OWN_TASK_FOLLOW_THROUGH_WAKEUP.name &&
    input.prompt.trim() === OWN_TASK_FOLLOW_THROUGH_WAKEUP.prompt
  );
}

/** The conversation a wakeup tool call acts on, and who is acting. */
export type SessionWakeupActor = {
  conversationId: string;
  userId: string;
};

export type CreateSessionWakeupInput = {
  name: string;
  prompt: string;
  /** One schedule string, e.g. "in 20m", "every 10m x3", "cron 0 9 * * 1-5". */
  schedule: string;
  reportPolicy?: SessionWakeupReportPolicy | null;
  internal?: boolean;
};

export type CreateSessionWakeupResult = {
  wakeup: SessionWakeupSummary;
  /** True when an equivalent active wakeup already existed and was reused. */
  duplicate: boolean;
  timeZone: string;
};

export async function isFastAgentVoiceCallActive(
  conversationId: string,
): Promise<boolean> {
  const marker = await db.query.fastAgentMessages.findFirst({
    where: and(
      eq(fastAgentMessages.conversationId, conversationId),
      eq(fastAgentMessages.eventType, ACP_ENVELOPE_EVENT_TYPES.VoiceCall),
    ),
    columns: { payload: true },
    orderBy: [desc(fastAgentMessages.ts), desc(fastAgentMessages.createdAt)],
  });
  return parseAcpVoiceCallPayload(marker?.payload ?? null)?.phase === 'started';
}

async function ensureOwnTaskFollowThroughWakeupForMode(
  actor: SessionWakeupActor,
  voiceMode: boolean,
  options: { onlyIfActive?: boolean } = {},
): Promise<CreateSessionWakeupResult | null> {
  const active = await listSessionWakeups(actor.conversationId);
  const ownTaskWakeups = active.filter(
    (wakeup) =>
      wakeup.internal &&
      wakeup.name === OWN_TASK_FOLLOW_THROUGH_WAKEUP.name &&
      wakeup.prompt === OWN_TASK_FOLLOW_THROUGH_WAKEUP.prompt,
  );
  if (options.onlyIfActive && ownTaskWakeups.length === 0) return null;

  const schedule = voiceMode
    ? OWN_TASK_FOLLOW_THROUGH_SCHEDULE.voice
    : OWN_TASK_FOLLOW_THROUGH_SCHEDULE.text;
  const inMinutes = voiceMode ? 0.5 : 10;
  await Promise.all(
    ownTaskWakeups
      .filter(
        (wakeup) =>
          wakeup.schedule.mode !== 'once' ||
          wakeup.schedule.inMinutes !== inMinutes,
      )
      .map((wakeup) =>
        cancelSessionWakeup({
          id: wakeup.id,
          conversationId: actor.conversationId,
        }),
      ),
  );

  return createSessionWakeup(actor, {
    ...OWN_TASK_FOLLOW_THROUGH_WAKEUP,
    schedule,
    internal: true,
  });
}

export async function ensureOwnTaskFollowThroughWakeup(
  actor: SessionWakeupActor,
): Promise<CreateSessionWakeupResult> {
  return (await ensureOwnTaskFollowThroughWakeupForMode(
    actor,
    await isFastAgentVoiceCallActive(actor.conversationId),
  ))!;
}

export async function refreshOwnTaskFollowThroughWakeupCadence(
  actor: SessionWakeupActor,
): Promise<CreateSessionWakeupResult | null> {
  return ensureOwnTaskFollowThroughWakeupForMode(
    actor,
    await isFastAgentVoiceCallActive(actor.conversationId),
    { onlyIfActive: true },
  );
}

/**
 * Cron defaults and next-run confirmations use the deployment timezone when
 * one is configured, otherwise UTC. The Slack-workspace fallback that
 * custom automations use lives in the SDK and is not needed here: the agent
 * can always name a timezone explicitly.
 */
export async function resolveSessionWakeupTimeZone(): Promise<string> {
  const settings = await db.query.deploymentSettings.findFirst({
    where: eq(deploymentSettings.id, DEFAULT_DEPLOYMENT_SETTINGS_ID),
    columns: { timeZone: true },
  });
  if (!settings?.timeZone) return 'UTC';
  try {
    return normalizeSessionWakeupTimeZone(settings.timeZone);
  } catch {
    return 'UTC';
  }
}

export function toSessionWakeupSummary(
  row: SessionWakeup,
): SessionWakeupSummary {
  return {
    id: row.id,
    name: row.name,
    prompt: row.prompt,
    schedule: row.schedule,
    scheduleDescription: describeSessionWakeupSchedule(row.schedule),
    reportPolicy: row.reportPolicy,
    internal: row.internal,
    status: row.status,
    runCount: row.runCount,
    maxRuns: row.maxRuns,
    until: row.until?.toISOString() ?? null,
    nextRunAt: row.nextRunAt?.toISOString() ?? null,
    lastFiredAt: row.lastFiredAt?.toISOString() ?? null,
    lastError: row.lastError,
    createdAt: row.createdAt.toISOString(),
  };
}

export async function createSessionWakeup(
  actor: SessionWakeupActor,
  input: CreateSessionWakeupInput,
  options: { now?: Date } = {},
): Promise<CreateSessionWakeupResult> {
  const now = options.now ?? new Date();
  const name = input.name.trim().replace(/\s+/g, ' ');
  const prompt = input.prompt.trim();
  if (!name) throw new SessionWakeupValidationError('name is required.');
  if (!prompt) throw new SessionWakeupValidationError('prompt is required.');

  const timeZone = await resolveSessionWakeupTimeZone();
  const { schedule, firstRunAt, maxRuns, until } = parseSessionWakeupSchedule(
    input.schedule,
    { now, defaultTimeZone: timeZone },
  );
  const recurring = isSessionWakeupRecurring(schedule);
  const reportPolicy: SessionWakeupReportPolicy =
    input.reportPolicy ?? (recurring ? 'only_when_notable' : 'always');

  const result = await admitSessionWakeup({
    conversationId: actor.conversationId,
    createdByUserId: actor.userId,
    name,
    prompt,
    schedule,
    reportPolicy,
    internal: input.internal ?? false,
    maxRuns,
    until,
    nextRunAt: firstRunAt,
  });
  if (result.outcome === 'cap_reached') {
    throw new SessionWakeupValidationError(
      `This conversation already has ${MAX_ACTIVE_SESSION_WAKEUPS} active wakeups. Cancel one before creating another.`,
    );
  }
  if (result.outcome === 'created') {
    enqueueSessionWakeupFireBestEffort({
      wakeupId: result.wakeup.id,
      runAt: firstRunAt.getTime(),
    });
  }

  return {
    wakeup: toSessionWakeupSummary(result.wakeup),
    duplicate: result.outcome === 'duplicate',
    timeZone,
  };
}

export async function listSessionWakeupsForConversation(
  conversationId: string,
  options: { includeTerminal?: boolean } = {},
): Promise<SessionWakeupSummary[]> {
  const rows = await listSessionWakeups(conversationId, options);
  return rows.map(toSessionWakeupSummary);
}

export async function getSessionWakeupForConversation(
  conversationId: string,
  wakeupId: string,
): Promise<SessionWakeupSummary | null> {
  const row = await getSessionWakeupById(wakeupId);
  if (!row || row.conversationId !== conversationId) return null;
  return toSessionWakeupSummary(row);
}

export type CancelSessionWakeupResult =
  | { outcome: 'cancelled'; wakeup: SessionWakeupSummary }
  | { outcome: 'already_terminal'; wakeup: SessionWakeupSummary }
  | { outcome: 'not_found' };

export async function cancelSessionWakeupForConversation(
  conversationId: string,
  wakeupId: string,
): Promise<CancelSessionWakeupResult> {
  const cancelled = await cancelSessionWakeup({ id: wakeupId, conversationId });
  if (cancelled) {
    return { outcome: 'cancelled', wakeup: toSessionWakeupSummary(cancelled) };
  }
  const row = await getSessionWakeupById(wakeupId);
  if (!row || row.conversationId !== conversationId) {
    return { outcome: 'not_found' };
  }
  return { outcome: 'already_terminal', wakeup: toSessionWakeupSummary(row) };
}

function formatNextRun(nextRunAt: string | null, timeZone: string): string {
  if (!nextRunAt) return 'no further runs';
  const date = new Date(nextRunAt);
  const local = new Intl.DateTimeFormat('en-US', {
    timeZone,
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date);
  return `${local} ${timeZone} (${date.toISOString()})`;
}

/**
 * Execute one `manage_wakeups` call on behalf of a Fast turn. Every branch
 * returns a JSON-serializable result the model can read; validation
 * problems come back as `{ success: false, error }` rather than throwing so
 * the turn can correct and retry.
 */
export async function handleManageWakeupsToolCall(
  actor: SessionWakeupActor,
  input: ManageWakeupsInput,
): Promise<Record<string, unknown>> {
  try {
    switch (input.action) {
      case 'create': {
        if (!input.name || !input.prompt || !input.schedule) {
          return {
            success: false,
            error: 'create requires name, prompt, and schedule.',
          };
        }
        const createInput = {
          name: input.name,
          prompt: input.prompt,
          schedule: input.schedule,
          reportPolicy: input.reportPolicy ?? null,
          internal: input.internal ?? false,
        };
        const result = isOwnTaskFollowThroughInput(createInput)
          ? await ensureOwnTaskFollowThroughWakeup(actor)
          : await createSessionWakeup(actor, createInput);
        return {
          success: true,
          duplicate: result.duplicate,
          wakeup: result.wakeup,
          timeZone: result.timeZone,
          nextRunLocal: formatNextRun(result.wakeup.nextRunAt, result.timeZone),
          note: result.duplicate
            ? 'An equivalent wakeup was already active in this conversation; it was reused instead of creating a duplicate.'
            : 'Scheduled. When it fires you will receive a scheduled_wakeup platform event in this conversation.',
        };
      }
      case 'list': {
        const timeZone = await resolveSessionWakeupTimeZone();
        const wakeups = await listSessionWakeupsForConversation(
          actor.conversationId,
        );
        return {
          success: true,
          now: new Date().toISOString(),
          timeZone,
          count: wakeups.length,
          wakeups,
        };
      }
      case 'get': {
        if (!input.wakeupId) {
          return { success: false, error: 'wakeupId is required for get.' };
        }
        const wakeup = await getSessionWakeupForConversation(
          actor.conversationId,
          input.wakeupId,
        );
        if (!wakeup) {
          return {
            success: false,
            error: 'No wakeup with that id exists in this conversation.',
          };
        }
        return { success: true, wakeup };
      }
      case 'cancel': {
        if (!input.wakeupId) {
          return { success: false, error: 'wakeupId is required for cancel.' };
        }
        const result = await cancelSessionWakeupForConversation(
          actor.conversationId,
          input.wakeupId,
        );
        switch (result.outcome) {
          case 'cancelled':
            return {
              success: true,
              cancelled: true,
              wakeup: result.wakeup,
              note: `Cancelled "${result.wakeup.name}". It will not fire again.`,
            };
          case 'already_terminal':
            return {
              success: true,
              cancelled: false,
              wakeup: result.wakeup,
              note: `"${result.wakeup.name}" was already ${result.wakeup.status}.`,
            };
          case 'not_found':
            return {
              success: false,
              error: 'No wakeup with that id exists in this conversation.',
            };
        }
      }
    }
  } catch (error) {
    if (error instanceof SessionWakeupValidationError) {
      return { success: false, error: error.message };
    }
    throw error;
  }
}
