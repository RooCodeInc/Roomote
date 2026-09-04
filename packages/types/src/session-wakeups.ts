import { z } from 'zod';

/**
 * Session wakeups let a Fast conversation schedule a message back to itself.
 * When a wakeup fires, the platform injects a `scheduled_wakeup` event into
 * the same conversation and the agent handles it as a normal turn with the
 * full conversation still in context. A one-shot wakeup is a reminder; a
 * recurring wakeup is a monitor.
 *
 * The tool takes the schedule as one short string ("in 2m", "every 10m x3",
 * "cron 0 9 * * 1-5 America/New_York") rather than a structured union.
 * Models fill every optional structured field with placeholders, and each
 * rejected placeholder costs a retry; a single required string has nothing to
 * pad.
 */

export const SESSION_WAKEUP_NAME_MAX_LENGTH = 80;
export const SESSION_WAKEUP_NAME_MIN_LENGTH = 3;
export const SESSION_WAKEUP_PROMPT_MAX_LENGTH = 4_000;
export const SESSION_WAKEUP_PROMPT_MIN_LENGTH = 10;
export const SESSION_WAKEUP_SCHEDULE_MAX_LENGTH = 160;
/** Active wakeups one conversation may hold at once. */
export const MAX_ACTIVE_SESSION_WAKEUPS = 10;
export const SESSION_WAKEUP_MIN_INTERVAL_MINUTES = 1;
/** Seven days. */
export const SESSION_WAKEUP_MAX_INTERVAL_MINUTES = 7 * 24 * 60;
/**
 * Recurring wakeups tighter than this must carry a run count or an end time,
 * so a tight polling loop cannot run forever.
 */
export const SESSION_WAKEUP_UNCAPPED_MIN_INTERVAL_MINUTES = 5;
/** Thirty days. A one-shot wakeup may not be scheduled further out. */
export const SESSION_WAKEUP_MAX_ONCE_HORIZON_MINUTES = 30 * 24 * 60;
export const SESSION_WAKEUP_MAX_RUNS_LIMIT = 1_000;
/** A recurring wakeup whose turns fail this many times in a row is retired. */
export const SESSION_WAKEUP_MAX_CONSECUTIVE_FAILURES = 5;

export const SESSION_WAKEUP_STATUSES = [
  'active',
  'completed',
  'cancelled',
  'failed',
] as const;
export type SessionWakeupStatus = (typeof SESSION_WAKEUP_STATUSES)[number];

export const SESSION_WAKEUP_REPORT_POLICIES = [
  'always',
  'only_when_notable',
] as const;
export type SessionWakeupReportPolicy =
  (typeof SESSION_WAKEUP_REPORT_POLICIES)[number];

/** The normalized schedule persisted with a wakeup. */
export const sessionWakeupScheduleSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('once'), at: z.string() }).strict(),
  z
    .object({ mode: z.literal('interval'), everyMinutes: z.number().int() })
    .strict(),
  z
    .object({
      mode: z.literal('cron'),
      expression: z.string(),
      timezone: z.string(),
    })
    .strict(),
]);

export type SessionWakeupSchedule = z.infer<typeof sessionWakeupScheduleSchema>;

export function isSessionWakeupRecurring(
  schedule: Pick<SessionWakeupSchedule, 'mode'>,
): boolean {
  return schedule.mode !== 'once';
}

export const SESSION_WAKEUP_SCHEDULE_GRAMMAR = `One of:
- "in <n>m|h|d" for a one-shot delay, e.g. "in 2m", "in 90m", "in 3h" (preferred for reminders and delayed follow-ups)
- "at <ISO 8601 date-time with UTC offset>" for a one-shot at an absolute time, e.g. "at 2026-09-04T15:00:00-04:00"
- "every <n>m|h|d" for a repeating interval, e.g. "every 10m", "every 6h"; add "x<count>" to stop after that many runs ("every 1m x3") or "until <ISO 8601>" to stop after a time ("every 10m until 2026-09-04T18:00:00Z")
- "cron <five-field expression> [IANA timezone]" for a calendar schedule, e.g. "cron 0 9 * * 1-5 America/New_York" (timezone defaults to the deployment timezone)`;

export const MANAGE_WAKEUPS_ACTIONS = [
  'create',
  'list',
  'get',
  'cancel',
] as const;
export type ManageWakeupsAction = (typeof MANAGE_WAKEUPS_ACTIONS)[number];

export const manageWakeupsFieldSchemas = {
  action: z
    .enum(MANAGE_WAKEUPS_ACTIONS)
    .describe(
      'create schedules a new wakeup; list shows the active wakeups in this conversation; get shows one by id; cancel stops one. Cancel is the only stop action.',
    ),
  wakeupId: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe('Required for get and cancel. Omit otherwise.'),
  name: z
    .string()
    .trim()
    .min(SESSION_WAKEUP_NAME_MIN_LENGTH)
    .max(SESSION_WAKEUP_NAME_MAX_LENGTH)
    .optional()
    .describe(
      '[create] Short label for the wakeup, for example "Check PR #85 for merge".',
    ),
  prompt: z
    .string()
    .trim()
    .min(SESSION_WAKEUP_PROMPT_MIN_LENGTH)
    .max(SESSION_WAKEUP_PROMPT_MAX_LENGTH)
    .optional()
    .describe(
      '[create] What to do when the wakeup fires. This conversation will still be in context, so keep it short and concrete. Say what to check, what counts as done, and what to tell the user.',
    ),
  schedule: z
    .string()
    .trim()
    .min(1)
    .max(SESSION_WAKEUP_SCHEDULE_MAX_LENGTH)
    .optional()
    .describe(`[create] ${SESSION_WAKEUP_SCHEDULE_GRAMMAR}`),
  reportPolicy: z
    .enum(SESSION_WAKEUP_REPORT_POLICIES)
    .optional()
    .describe(
      '[create] "always" replies to the user on every run (default for one-shots). "only_when_notable" stays silent unless there is news or the condition resolved (default for repeating schedules). Omit to use the default.',
    ),
} satisfies z.ZodRawShape;

export const manageWakeupsInputSchema = z.object(manageWakeupsFieldSchemas);

export type ManageWakeupsInput = z.infer<typeof manageWakeupsInputSchema>;

export const MANAGE_WAKEUPS_TOOL_NAME = 'manage_wakeups' as const;

export const MANAGE_WAKEUPS_TOOL_DESCRIPTION = `Schedule this conversation to wake itself up later, once or on a cadence. When a wakeup fires, you receive a scheduled_wakeup platform event in this same conversation with the full history still in context, so the prompt can be brief and refer to things discussed here. Use it for reminders ("remind me in 20 minutes", "ping me at 3pm") and for monitors ("check every 10 minutes whether CI is green", "every weekday at 9am summarize open PRs").

The schedule is one short string. Reminders and delayed follow-ups use "in <n>m" ("in 20m"); use "at <ISO date-time with offset>" only for an explicit absolute time. Repeating checks use "every <n>m" or "cron ...", optionally with "x<count>" or "until <ISO date-time>". Pick an interval that matches how fast the monitored thing actually changes, not how soon you want an answer; intervals under ${SESSION_WAKEUP_UNCAPPED_MIN_INTERVAL_MINUTES} minutes need "x<count>" or "until".

- A monitor keeps running until the user cancels it or the condition definitively resolves. A run that finds nothing new is still useful. When a monitored condition resolves, tell the user and cancel the wakeup.
- Results arrive automatically as a new turn in this conversation. Never poll, sleep, or wait for a wakeup inside a turn.
- When the user says stop, cancel, remove, delete, or end a wakeup, use cancel. There is no pause.
- Creating a wakeup that matches an active one (same prompt and schedule) returns the existing wakeup instead of a duplicate. At most ${MAX_ACTIVE_SESSION_WAKEUPS} wakeups may be active per conversation.
- Only send the fields the action needs; omit the rest. After creating a wakeup, confirm what will happen and when in one short sentence using the returned nextRunAt.`;

export const MANAGE_WAKEUPS_TOOL = {
  name: MANAGE_WAKEUPS_TOOL_NAME,
  title: 'Manage Wakeups',
  description: MANAGE_WAKEUPS_TOOL_DESCRIPTION,
  inputSchema: manageWakeupsFieldSchemas,
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: false,
  },
} as const;

/** Tool-facing view of a wakeup row. */
export type SessionWakeupSummary = {
  id: string;
  name: string;
  prompt: string;
  schedule: SessionWakeupSchedule;
  scheduleDescription: string;
  reportPolicy: SessionWakeupReportPolicy;
  status: SessionWakeupStatus;
  runCount: number;
  maxRuns: number | null;
  until: string | null;
  nextRunAt: string | null;
  lastFiredAt: string | null;
  lastError: string | null;
  createdAt: string;
};

export const FAST_AGENT_SCHEDULED_WAKEUP_EVENT_TYPE =
  'scheduled_wakeup' as const;

/**
 * The parent event a firing wakeup admits into its conversation. The prompt
 * is repeated here so the turn does not depend on the row still existing.
 */
export const fastAgentScheduledWakeupEventSchema = z.object({
  type: z.literal(FAST_AGENT_SCHEDULED_WAKEUP_EVENT_TYPE),
  /** `${wakeupId}:${runNumber}`; one admission per occurrence. */
  eventId: z.string().min(1),
  wakeupId: z.string().min(1),
  name: z.string().min(1),
  prompt: z.string().min(1),
  runNumber: z.number().int().min(1),
  maxRuns: z.number().int().nullable(),
  firedAt: z.string().min(1),
  nextRunAt: z.string().nullable(),
  reportPolicy: z.enum(SESSION_WAKEUP_REPORT_POLICIES),
  createdByUserId: z.string().min(1),
});

export type FastAgentScheduledWakeupEvent = z.infer<
  typeof fastAgentScheduledWakeupEventSchema
>;
