import {
  buildSessionWakeupPromptSignature,
  cancelSessionWakeup,
  countActiveSessionWakeups,
  db,
  deploymentSettings,
  eq,
  getSessionWakeupById,
  insertSessionWakeup,
  listActiveSessionWakeups,
  listSessionWakeups,
  type SessionWakeup,
} from '@roomote/db/server';
import {
  MAX_ACTIVE_SESSION_WAKEUPS,
  isSessionWakeupRecurring,
  type ManageWakeupsInput,
  type SessionWakeupReportPolicy,
  type SessionWakeupScheduleInput,
  type SessionWakeupSummary,
} from '@roomote/types';

import { enqueueSessionWakeupFireBestEffort } from './queue';
import {
  SessionWakeupValidationError,
  describeSessionWakeupSchedule,
  normalizeSessionWakeupSchedule,
  normalizeSessionWakeupTimeZone,
  validateSessionWakeupCaps,
} from './schedule';

const DEFAULT_DEPLOYMENT_SETTINGS_ID = 'default';

/** The conversation a wakeup tool call acts on, and who is acting. */
export type SessionWakeupActor = {
  conversationId: string;
  userId: string;
};

export type CreateSessionWakeupInput = {
  name: string;
  prompt: string;
  schedule: SessionWakeupScheduleInput;
  maxRuns?: number | null;
  until?: string | null;
  reportPolicy?: SessionWakeupReportPolicy | null;
};

export type CreateSessionWakeupResult = {
  wakeup: SessionWakeupSummary;
  /** True when an equivalent active wakeup already existed and was reused. */
  duplicate: boolean;
  timeZone: string;
};

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

function schedulesMatch(
  left: SessionWakeup['schedule'],
  right: SessionWakeup['schedule'],
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
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
  const { schedule, firstRunAt } = normalizeSessionWakeupSchedule(
    input.schedule,
    { now, defaultTimeZone: timeZone },
  );
  const maxRuns = input.maxRuns ?? null;
  const until = input.until ? new Date(input.until) : null;
  if (until && Number.isNaN(until.getTime())) {
    throw new SessionWakeupValidationError(
      'until must be an ISO 8601 date-time.',
    );
  }
  validateSessionWakeupCaps({ schedule, firstRunAt, maxRuns, until });
  const reportPolicy: SessionWakeupReportPolicy =
    input.reportPolicy ??
    (isSessionWakeupRecurring(schedule) ? 'only_when_notable' : 'always');

  // Reuse an equivalent active wakeup instead of stacking duplicates; a model
  // that retries a create call must not double-schedule.
  const promptSignature = buildSessionWakeupPromptSignature(prompt);
  const active = await listActiveSessionWakeups(actor.conversationId);
  const existing = active.find(
    (row) =>
      row.promptSignature === promptSignature &&
      schedulesMatch(row.schedule, schedule),
  );
  if (existing) {
    return {
      wakeup: toSessionWakeupSummary(existing),
      duplicate: true,
      timeZone,
    };
  }

  const activeCount = await countActiveSessionWakeups(actor.conversationId);
  if (activeCount >= MAX_ACTIVE_SESSION_WAKEUPS) {
    throw new SessionWakeupValidationError(
      `This conversation already has ${MAX_ACTIVE_SESSION_WAKEUPS} active wakeups. Cancel one before creating another.`,
    );
  }

  const row = await insertSessionWakeup({
    conversationId: actor.conversationId,
    createdByUserId: actor.userId,
    name,
    prompt,
    schedule,
    reportPolicy,
    maxRuns,
    until,
    nextRunAt: firstRunAt,
  });
  enqueueSessionWakeupFireBestEffort({
    wakeupId: row.id,
    runAt: firstRunAt.getTime(),
  });

  return { wakeup: toSessionWakeupSummary(row), duplicate: false, timeZone };
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
        const result = await createSessionWakeup(actor, {
          name: input.name,
          prompt: input.prompt,
          schedule: input.schedule,
          maxRuns: input.maxRuns ?? null,
          until: input.until ?? null,
          reportPolicy: input.reportPolicy ?? null,
        });
        return {
          success: true,
          duplicate: result.duplicate,
          wakeup: result.wakeup,
          timeZone: result.timeZone,
          nextRunLocal: formatNextRun(result.wakeup.nextRunAt, result.timeZone),
          note: result.duplicate
            ? 'An equivalent wakeup was already active in this conversation; it was reused instead of creating a duplicate.'
            : 'Scheduled. When it fires you will receive a scheduled_wakeup platform event in this conversation. Confirm the plan to the user in one sentence.',
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
