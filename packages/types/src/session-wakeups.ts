import { z } from 'zod';

/**
 * Session wakeups let a Fast conversation schedule a message back to itself.
 * When a wakeup fires, the platform injects a `scheduled_wakeup` event into
 * the same conversation and the agent handles it as a normal turn with the
 * full conversation still in context. A one-shot wakeup is a reminder; a
 * recurring wakeup is a monitor.
 */

export const SESSION_WAKEUP_NAME_MAX_LENGTH = 80;
export const SESSION_WAKEUP_NAME_MIN_LENGTH = 3;
export const SESSION_WAKEUP_PROMPT_MAX_LENGTH = 4_000;
export const SESSION_WAKEUP_PROMPT_MIN_LENGTH = 10;
export const SESSION_WAKEUP_CRON_MAX_LENGTH = 120;
/** Active wakeups one conversation may hold at once. */
export const MAX_ACTIVE_SESSION_WAKEUPS = 10;
export const SESSION_WAKEUP_MIN_INTERVAL_MINUTES = 1;
/** Seven days. */
export const SESSION_WAKEUP_MAX_INTERVAL_MINUTES = 7 * 24 * 60;
/**
 * Recurring wakeups tighter than this must carry `maxRuns` or `until`, so a
 * tight polling loop cannot run forever.
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

const isoDateTimeSchema = z
  .string()
  .trim()
  .min(1)
  .refine((value) => !Number.isNaN(Date.parse(value)), {
    message: 'Must be an ISO 8601 date-time.',
  });

/**
 * The schedule as the agent supplies it. `once` accepts either a relative
 * delay or an absolute time; the relative form is preferred because it does
 * not require the model to do clock arithmetic.
 */
export const sessionWakeupScheduleInputSchema = z.discriminatedUnion('mode', [
  z
    .object({
      mode: z
        .literal('once')
        .describe(
          'Fire one time. Use this for every reminder or delayed follow-up ("in 4 minutes", "at 3pm", "tomorrow morning").',
        ),
      inMinutes: z
        .number()
        .int()
        .min(1)
        .max(SESSION_WAKEUP_MAX_ONCE_HORIZON_MINUTES)
        .optional()
        .describe(
          'Minutes from now. Preferred over "at" for relative requests. Provide exactly one of inMinutes or at.',
        ),
      at: isoDateTimeSchema
        .optional()
        .describe(
          'Absolute ISO 8601 date-time with a UTC offset, for example 2026-09-04T15:00:00-04:00. Provide exactly one of inMinutes or at.',
        ),
    })
    .strict(),
  z
    .object({
      mode: z
        .literal('interval')
        .describe(
          'Fire repeatedly on a fixed interval measured from each run.',
        ),
      everyMinutes: z
        .number()
        .int()
        .min(SESSION_WAKEUP_MIN_INTERVAL_MINUTES)
        .max(SESSION_WAKEUP_MAX_INTERVAL_MINUTES)
        .describe(
          `Minutes between runs (${SESSION_WAKEUP_MIN_INTERVAL_MINUTES}-${SESSION_WAKEUP_MAX_INTERVAL_MINUTES}). Intervals under ${SESSION_WAKEUP_UNCAPPED_MIN_INTERVAL_MINUTES} minutes require maxRuns or until.`,
        ),
    })
    .strict(),
  z
    .object({
      mode: z
        .literal('cron')
        .describe('Fire repeatedly on a calendar schedule.'),
      expression: z
        .string()
        .trim()
        .min(9)
        .max(SESSION_WAKEUP_CRON_MAX_LENGTH)
        .describe(
          'Standard five-field cron expression (minute hour day-of-month month day-of-week), for example "0 9 * * 1-5" for 9am on weekdays.',
        ),
      timezone: z
        .string()
        .trim()
        .min(1)
        .optional()
        .describe(
          'IANA timezone for the cron expression, for example "America/New_York". Defaults to the deployment timezone.',
        ),
    })
    .strict(),
]);

export type SessionWakeupScheduleInput = z.infer<
  typeof sessionWakeupScheduleInputSchema
>;

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
    .describe('Required for get and cancel.'),
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
  schedule: sessionWakeupScheduleInputSchema
    .optional()
    .describe(
      '[create] Exactly one schedule mode. Reminders must use mode "once"; monitors use "interval" or "cron".',
    ),
  maxRuns: z
    .number()
    .int()
    .min(1)
    .max(SESSION_WAKEUP_MAX_RUNS_LIMIT)
    .optional()
    .describe(
      '[create] Stop after this many runs. Only for interval or cron schedules.',
    ),
  until: isoDateTimeSchema
    .optional()
    .describe(
      '[create] Stop after this ISO 8601 date-time. Only for interval or cron schedules.',
    ),
  reportPolicy: z
    .enum(SESSION_WAKEUP_REPORT_POLICIES)
    .optional()
    .describe(
      '[create] "always" replies to the user on every run (default for once). "only_when_notable" stays silent unless there is news or the condition resolved (default for interval and cron).',
    ),
} satisfies z.ZodRawShape;

export const manageWakeupsInputSchema = z.object(manageWakeupsFieldSchemas);

export type ManageWakeupsInput = z.infer<typeof manageWakeupsInputSchema>;

export const MANAGE_WAKEUPS_TOOL_NAME = 'manage_wakeups' as const;

export const MANAGE_WAKEUPS_TOOL_DESCRIPTION = `Schedule this conversation to wake itself up later, once or on a cadence. When a wakeup fires, you receive a scheduled_wakeup platform event in this same conversation with the full history still in context, so the prompt can be brief and refer to things discussed here. Use it for reminders ("remind me in 20 minutes", "ping me at 3pm") and for monitors ("check every 10 minutes whether CI is green", "every weekday at 9am summarize open PRs").

Choose the schedule deliberately:
- One-shot reminders and delayed follow-ups must use schedule.mode "once". Prefer inMinutes for relative times; use at only for an explicit absolute time and include the UTC offset.
- Repeating monitors use mode "interval" or mode "cron". Pick an interval that matches how fast the monitored thing actually changes, not how soon you want an answer. Intervals under ${SESSION_WAKEUP_UNCAPPED_MIN_INTERVAL_MINUTES} minutes need maxRuns or until.
- A monitor keeps running until the user cancels it or the condition definitively resolves. A run that finds nothing new is still useful. When a monitored condition resolves, tell the user and cancel the wakeup.
- Results arrive automatically as a new turn in this conversation. Never poll, sleep, or wait for a wakeup inside a turn.
- When the user says stop, cancel, remove, delete, or end a wakeup, use cancel. There is no pause.
- Creating a wakeup that matches an active one (same prompt and schedule) returns the existing wakeup instead of a duplicate. At most ${MAX_ACTIVE_SESSION_WAKEUPS} wakeups may be active per conversation.
- After creating a wakeup, confirm what will happen and when in one short sentence using the returned nextRunAt.`;

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
