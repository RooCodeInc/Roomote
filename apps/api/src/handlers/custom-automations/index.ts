import { Hono } from 'hono';
import type { Context } from 'hono';
import { z } from 'zod';

import {
  and,
  createCustomAutomation,
  db,
  deleteCustomAutomation,
  eq,
  getCustomAutomationById,
  isNull,
  listCustomAutomations,
  updateCustomAutomation,
  users,
} from '@roomote/db/server';
import {
  listConnectedCommunicationProviders,
  resolveCustomAutomationSchedule,
  runCustomAutomationNow,
} from '@roomote/sdk/server';
import type {
  BackgroundAutomationProvider,
  BackgroundAutomationTargetKind,
  CustomAutomationScheduleMode,
  OptionalAutomationTarget,
} from '@roomote/types';

import type { Variables } from '../../types';
import type { McpAuth } from '../mcp/middleware';
import { resolveActingUserIdOrNull } from '../mcp/proxy-utils';

type CustomAutomationVariables = Variables & {
  mcpAuth: McpAuth;
  customAutomationAdminId: string;
};

const writeSchema = z.object({
  name: z.string().trim().min(1).max(100),
  prompt: z.string().trim().min(1).max(8_000),
  enabled: z.boolean().default(true),
  schedule: z.string().trim().min(1).max(500),
  environmentId: z.string().uuid(),
  targetProvider: z.enum(['slack', 'discord', 'teams', 'telegram']).optional(),
  targetChannelId: z.string().trim().min(1).max(160).optional(),
  targetServiceUrl: z.string().trim().min(1).max(500).optional(),
});

const updateSchema = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  prompt: z.string().trim().min(1).max(8_000).optional(),
  enabled: z.boolean().optional(),
  schedule: z.string().trim().min(1).max(500).optional(),
  environmentId: z.string().uuid().optional(),
  targetProvider: z
    .enum(['slack', 'discord', 'teams', 'telegram'])
    .nullable()
    .optional(),
  targetChannelId: z.string().trim().min(1).max(160).optional(),
  targetServiceUrl: z.string().trim().min(1).max(500).optional(),
});

const UNIQUE_VIOLATION_CODE = '23505';
const NAME_UNIQUE_INDEX = 'custom_automations_name_unique_idx';
export const DUPLICATE_AUTOMATION_NAME_ERROR =
  'A custom automation with this name already exists.';

/**
 * Whether the error (or anything in its cause chain — drizzle wraps the
 * driver error in a DrizzleQueryError) is the Postgres unique violation for
 * the custom automation name index specifically. Both signals are required:
 * a 23505 on some other constraint is not a duplicate name and must rethrow
 * to the logged 500 path instead of being mislabeled. The two signals may
 * live on different levels of the cause chain (wrapper message vs. driver
 * error fields), so they are accumulated across the walk.
 */
function isDuplicateNameViolation(error: unknown): boolean {
  let sawUniqueViolationCode = false;
  let sawNameUniqueIndex = false;

  for (
    let current = error, depth = 0;
    current !== null && current !== undefined && depth < 10;
    depth += 1
  ) {
    const candidate = current as {
      code?: unknown;
      constraint?: unknown;
      message?: unknown;
      cause?: unknown;
    };

    if (candidate.code === UNIQUE_VIOLATION_CODE) {
      sawUniqueViolationCode = true;
    }

    if (
      candidate.constraint === NAME_UNIQUE_INDEX ||
      (typeof candidate.message === 'string' &&
        candidate.message.includes(NAME_UNIQUE_INDEX))
    ) {
      sawNameUniqueIndex = true;
    }

    if (sawUniqueViolationCode && sawNameUniqueIndex) {
      return true;
    }

    current = candidate.cause;
  }

  return false;
}

/**
 * Expected validation failures thrown as plain Errors by
 * `createCustomAutomation` / `updateCustomAutomation` (packages/db),
 * `buildTarget`, and schedule validation (packages/sdk). These are safe to
 * echo to the admin-only MCP client so the calling agent can self-correct;
 * the web tRPC surface already shows the same messages to admins. Anything
 * not matched here is rethrown so the app-level onError handler logs it and
 * returns a generic 500.
 */
const VALIDATION_ERROR_PATTERNS: RegExp[] = [
  /^Name is required\.$/,
  /^Name must be at most \d+ characters\.$/,
  /^Prompt is required\.$/,
  /^Prompt must be at most \d+ characters\.$/,
  /^Invalid schedule mode: /,
  /^Cron expression is required for a cron schedule\.$/,
  /^Cron expression is only valid for a cron schedule\.$/,
  /^Cron expression must be at most \d+ characters\.$/,
  /^Cron expression must be between 1 and \d+ characters\.$/,
  /^Use a standard five-field cron expression\.$/,
  /^Environment is required\.$/,
  /^Selected environment was not found\.$/,
  /^Custom automation was not found\.$/,
  /^Report destination must include a provider, target kind, and channel\.$/,
  /^You can create at most \d+ custom automations\.$/,
  /^targetChannelId is required when targetProvider is set\.$/,
  /^Timezone is required\.$/,
  /^Choose a valid IANA timezone\.$/,
];

/**
 * Translate an expected validation failure into a 400 response with the
 * message, or return null when the error is not a known validation failure
 * (callers rethrow those so onError logs them as unexpected 500s).
 */
function knownErrorResponse(
  c: Pick<Context, 'json'>,
  error: unknown,
): Response | null {
  if (isDuplicateNameViolation(error)) {
    return c.json({ error: DUPLICATE_AUTOMATION_NAME_ERROR }, 400);
  }

  if (
    error instanceof Error &&
    VALIDATION_ERROR_PATTERNS.some((pattern) => pattern.test(error.message))
  ) {
    return c.json({ error: error.message }, 400);
  }

  return null;
}

async function requireAdmin(auth: McpAuth): Promise<string | null> {
  let userId: string | null;
  try {
    userId = await resolveActingUserIdOrNull({
      userId: auth.userId ?? null,
      tokenType: auth.authContext.tokenType,
      ...('runId' in auth.authContext ? { runId: auth.authContext.runId } : {}),
    });
  } catch {
    return null;
  }
  if (!userId) return null;

  const user = await db.query.users.findFirst({
    where: and(
      eq(users.id, userId),
      eq(users.role, 'admin'),
      isNull(users.deletedAt),
    ),
    columns: { id: true },
  });
  return user?.id ?? null;
}

function buildTarget(
  input: Pick<
    z.infer<typeof writeSchema>,
    'targetProvider' | 'targetChannelId' | 'targetServiceUrl'
  >,
): OptionalAutomationTarget {
  if (!input.targetProvider) return {};
  if (!input.targetChannelId) {
    throw new Error('targetChannelId is required when targetProvider is set.');
  }

  const kinds: Record<string, BackgroundAutomationTargetKind> = {
    slack: 'slack_channel',
    discord: 'discord_channel',
    teams: 'teams_channel',
    telegram: 'telegram_chat',
  };
  return {
    provider: input.targetProvider as BackgroundAutomationProvider,
    targetKind: kinds[input.targetProvider]!,
    externalRef: input.targetChannelId,
    ...(input.targetServiceUrl
      ? { metadata: { serviceUrl: input.targetServiceUrl } }
      : {}),
  };
}

async function resolveWriteSchedule(schedule: string, userId: string) {
  if (
    ['off', 'every_hour', 'every_6_hours', 'daily', 'weekly'].includes(schedule)
  ) {
    return {
      status: 'resolved' as const,
      scheduleMode: schedule as CustomAutomationScheduleMode,
      cronExpression: null,
      resolution: null,
    };
  }

  const resolution = await resolveCustomAutomationSchedule({
    schedule,
    userId,
  });
  if (resolution.status === 'ambiguous' || !resolution.cronExpression) {
    return {
      status: 'ambiguous' as const,
      clarification: resolution.clarification,
      resolution,
    };
  }
  return {
    status: 'resolved' as const,
    scheduleMode: 'cron' as const,
    cronExpression: resolution.cronExpression,
    resolution,
  };
}

export const customAutomationsRouter = new Hono<{
  Variables: CustomAutomationVariables;
}>();

customAutomationsRouter.use('*', async (c, next) => {
  const userId = await requireAdmin(c.get('mcpAuth'));
  if (!userId) return c.json({ error: 'Admin access required' }, 403);
  c.set('customAutomationAdminId', userId);
  await next();
});

function adminId(c: {
  get: (key: 'customAutomationAdminId') => string;
}): string {
  return c.get('customAutomationAdminId');
}

customAutomationsRouter.get('/', async (c) =>
  c.json({ automations: await listCustomAutomations() }),
);

customAutomationsRouter.post('/resolve-schedule', async (c) => {
  const parsed = z
    .object({ schedule: z.string().trim().min(1).max(500) })
    .safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
  try {
    return c.json(
      await resolveCustomAutomationSchedule({
        schedule: parsed.data.schedule,
        userId: adminId(c),
      }),
    );
  } catch (error) {
    const known = knownErrorResponse(c, error);
    if (known) return known;
    throw error;
  }
});

customAutomationsRouter.post('/', async (c) => {
  const parsed = writeSchema.safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
  try {
    const schedule = await resolveWriteSchedule(
      parsed.data.schedule,
      adminId(c),
    );
    if (schedule.status === 'ambiguous') return c.json(schedule, 409);

    if (parsed.data.targetProvider) {
      const connected = await listConnectedCommunicationProviders();
      if (!connected.includes(parsed.data.targetProvider)) {
        return c.json(
          { error: `${parsed.data.targetProvider} is not connected.` },
          400,
        );
      }
    }

    const automation = await createCustomAutomation({
      name: parsed.data.name,
      prompt: parsed.data.prompt,
      enabled: parsed.data.enabled,
      scheduleMode: schedule.scheduleMode,
      cronExpression: schedule.cronExpression,
      environmentId: parsed.data.environmentId,
      target: buildTarget(parsed.data),
      createdByUserId: adminId(c),
    });
    return c.json({ automation, resolution: schedule.resolution }, 201);
  } catch (error) {
    const known = knownErrorResponse(c, error);
    if (known) return known;
    throw error;
  }
});

customAutomationsRouter.patch('/:id', async (c) => {
  const parsed = updateSchema.safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
  const existing = await getCustomAutomationById(c.req.param('id'));
  if (!existing) {
    return c.json({ error: 'Custom automation was not found.' }, 404);
  }
  try {
    const schedule = parsed.data.schedule
      ? await resolveWriteSchedule(parsed.data.schedule, adminId(c))
      : {
          status: 'resolved' as const,
          scheduleMode: existing.scheduleMode as CustomAutomationScheduleMode,
          cronExpression: existing.cronExpression,
          resolution: null,
        };
    if (schedule.status === 'ambiguous') return c.json(schedule, 409);
    if (parsed.data.targetProvider) {
      const connected = await listConnectedCommunicationProviders();
      if (!connected.includes(parsed.data.targetProvider)) {
        return c.json(
          { error: `${parsed.data.targetProvider} is not connected.` },
          400,
        );
      }
    }
    const existingTarget = existing.target;
    const clearTarget = parsed.data.targetProvider === null;
    const targetProvider =
      parsed.data.targetProvider ??
      (existingTarget.provider === 'slack' ||
      existingTarget.provider === 'discord' ||
      existingTarget.provider === 'teams' ||
      existingTarget.provider === 'telegram'
        ? existingTarget.provider
        : undefined);
    const targetChannelId =
      parsed.data.targetChannelId ?? existingTarget.externalRef ?? undefined;
    const existingServiceUrl =
      typeof existingTarget.metadata?.serviceUrl === 'string'
        ? existingTarget.metadata.serviceUrl
        : undefined;
    const automation = await updateCustomAutomation(c.req.param('id'), {
      name: parsed.data.name ?? existing.name,
      prompt: parsed.data.prompt ?? existing.prompt,
      enabled: parsed.data.enabled ?? existing.enabled,
      scheduleMode: schedule.scheduleMode,
      cronExpression: schedule.cronExpression,
      environmentId: parsed.data.environmentId ?? existing.environmentId ?? '',
      target: clearTarget
        ? {}
        : targetProvider && targetChannelId
          ? buildTarget({
              targetProvider,
              targetChannelId,
              targetServiceUrl:
                parsed.data.targetServiceUrl ?? existingServiceUrl,
            })
          : existingTarget,
    });
    return c.json({ automation, resolution: schedule.resolution });
  } catch (error) {
    const known = knownErrorResponse(c, error);
    if (known) return known;
    throw error;
  }
});

customAutomationsRouter.delete('/:id', async (c) => {
  const existing = await getCustomAutomationById(c.req.param('id'));
  if (!existing)
    return c.json({ error: 'Custom automation was not found.' }, 404);
  await deleteCustomAutomation(existing.id);
  return c.json({ deleted: { id: existing.id, name: existing.name } });
});

customAutomationsRouter.post('/:id/run', async (c) => {
  const result = await runCustomAutomationNow(c.req.param('id'));
  return c.json(result, result.outcome === 'failed' ? 400 : 200);
});
