import { Hono } from 'hono';
import type { Context } from 'hono';
import { z } from 'zod';

import {
  and,
  createCustomAutomation,
  db,
  deleteCustomAutomation,
  eq,
  getDeploymentTaskModelOptions,
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
import {
  ALL_REPOSITORIES,
  type BackgroundAutomationProvider,
  type BackgroundAutomationTargetKind,
  type CustomAutomationScheduleMode,
  type OptionalAutomationTarget,
} from '@roomote/types';
import { isBackgroundAutomationUserTargetKind } from '@roomote/types';
import { toActivationAutomationDestinationProvider } from '@roomote/telemetry';
import { captureActivationCustomAutomationChanged } from '@roomote/telemetry/server';

import type { Variables } from '../../types';
import type { McpAuth } from '../mcp/middleware';
import { resolveActingUserIdOrNull } from '../mcp/proxy-utils';

type CustomAutomationVariables = Variables & {
  mcpAuth: McpAuth;
  customAutomationAdminId: string;
};

const modelSchema = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .regex(/^[^/\s]+\/.+$/u, 'Model must use provider/model format.');

const environmentTargetSchema = z.union([
  z.string().uuid(),
  z.literal(ALL_REPOSITORIES),
]);

const writeSchema = z.object({
  name: z.string().trim().min(1).max(100),
  prompt: z.string().trim().min(1).max(8_000),
  enabled: z.boolean().default(true),
  schedule: z.string().trim().min(1).max(500),
  model: modelSchema.optional(),
  environmentId: environmentTargetSchema,
  targetProvider: z.enum(['slack', 'discord', 'teams', 'telegram']).optional(),
  targetMode: z.enum(['channel', 'direct_message']).optional(),
  targetChannelId: z.string().trim().min(1).max(160).optional(),
  targetServiceUrl: z.string().trim().min(1).max(500).optional(),
});

const updateSchema = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  prompt: z.string().trim().min(1).max(8_000).optional(),
  enabled: z.boolean().optional(),
  schedule: z.string().trim().min(1).max(500).optional(),
  model: modelSchema.nullable().optional(),
  environmentId: environmentTargetSchema.optional(),
  targetProvider: z
    .enum(['slack', 'discord', 'teams', 'telegram'])
    .nullable()
    .optional(),
  targetMode: z.enum(['channel', 'direct_message']).optional(),
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
  /^Model must be at most \d+ characters\.$/,
  /^Model must use provider\/model format\.$/,
  /^Model ".+" is not enabled for new tasks\.$/,
  /^Environment is required\.$/,
  /^Selected environment was not found\.$/,
  /^Custom automation was not found\.$/,
  /^Report destination must include a provider, target kind, and reference\.$/,
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
    'targetProvider' | 'targetMode' | 'targetChannelId' | 'targetServiceUrl'
  >,
  ownerUserId: string,
): OptionalAutomationTarget {
  if (!input.targetProvider) return {};
  const directMessage = input.targetMode === 'direct_message';
  if (!directMessage && !input.targetChannelId) {
    throw new Error('targetChannelId is required when targetProvider is set.');
  }

  const kinds: Record<string, BackgroundAutomationTargetKind> = {
    slack: 'slack_channel',
    discord: 'discord_channel',
    teams: 'teams_channel',
    telegram: 'telegram_chat',
  };
  const userKinds: Record<string, BackgroundAutomationTargetKind> = {
    slack: 'slack_user',
    discord: 'discord_user',
    teams: 'teams_user',
    telegram: 'telegram_user',
  };
  return {
    provider: input.targetProvider as BackgroundAutomationProvider,
    targetKind: directMessage
      ? userKinds[input.targetProvider]!
      : kinds[input.targetProvider]!,
    externalRef: directMessage ? ownerUserId : input.targetChannelId!,
    ...(!directMessage && input.targetServiceUrl
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

async function assertEnabledModel(model: string | null | undefined) {
  if (!model) return;

  const { models } = await getDeploymentTaskModelOptions();
  if (!models.some((option) => option.id === model)) {
    throw new Error(`Model "${model}" is not enabled for new tasks.`);
  }
}

function toApiAutomation<
  T extends { allRepositories: boolean; environmentId: string | null },
>(automation: T): Omit<T, 'environmentId'> & { environmentId: string | null } {
  return {
    ...automation,
    environmentId: automation.allRepositories
      ? ALL_REPOSITORIES
      : automation.environmentId,
  };
}

customAutomationsRouter.get('/', async (c) =>
  c.json({
    automations: (await listCustomAutomations()).map(toApiAutomation),
  }),
);

customAutomationsRouter.get('/models', async (c) =>
  c.json(await getDeploymentTaskModelOptions()),
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
    await assertEnabledModel(parsed.data.model);
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
      model: parsed.data.model ?? null,
      environmentId: parsed.data.environmentId,
      target: buildTarget(parsed.data, adminId(c)),
      createdByUserId: adminId(c),
    });
    void captureActivationCustomAutomationChanged(
      'created',
      parsed.data.targetProvider ?? null,
    );
    return c.json(
      {
        automation: toApiAutomation(automation),
        resolution: schedule.resolution,
      },
      201,
    );
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
    if (typeof parsed.data.model === 'string') {
      await assertEnabledModel(parsed.data.model);
    }
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
    const providerChanged =
      parsed.data.targetProvider !== undefined &&
      parsed.data.targetProvider !== null &&
      parsed.data.targetProvider !== existingTarget.provider;
    const targetProvider =
      parsed.data.targetProvider ??
      (existingTarget.provider === 'slack' ||
      existingTarget.provider === 'discord' ||
      existingTarget.provider === 'teams' ||
      existingTarget.provider === 'telegram'
        ? existingTarget.provider
        : undefined);
    const targetMode =
      parsed.data.targetMode ??
      (!providerChanged &&
      isBackgroundAutomationUserTargetKind(existingTarget.targetKind)
        ? 'direct_message'
        : 'channel');
    const targetChannelId =
      parsed.data.targetChannelId ??
      (targetMode === 'channel' &&
      !providerChanged &&
      !isBackgroundAutomationUserTargetKind(existingTarget.targetKind)
        ? existingTarget.externalRef
        : undefined);
    const destinationChanged =
      parsed.data.targetProvider !== undefined ||
      parsed.data.targetMode !== undefined ||
      parsed.data.targetChannelId !== undefined ||
      parsed.data.targetServiceUrl !== undefined;
    if (
      !clearTarget &&
      destinationChanged &&
      targetProvider &&
      targetMode === 'channel' &&
      !targetChannelId
    ) {
      throw new Error(
        'targetChannelId is required when targetProvider is set.',
      );
    }
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
      // Explicit null clears the override; omitted keeps the existing value.
      model:
        parsed.data.model === null
          ? null
          : (parsed.data.model ?? existing.model),
      environmentId:
        parsed.data.environmentId ??
        (existing.allRepositories
          ? ALL_REPOSITORIES
          : (existing.environmentId ?? '')),
      target: clearTarget
        ? {}
        : targetProvider && (targetMode === 'direct_message' || targetChannelId)
          ? buildTarget(
              {
                targetProvider,
                targetMode,
                targetChannelId,
                targetServiceUrl:
                  parsed.data.targetServiceUrl ?? existingServiceUrl,
              },
              existing.createdByUserId ?? adminId(c),
            )
          : existingTarget,
    });
    return c.json({
      automation: toApiAutomation(automation),
      resolution: schedule.resolution,
    });
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
  void captureActivationCustomAutomationChanged(
    'deleted',
    toActivationAutomationDestinationProvider(existing.target.provider),
  );
  return c.json({ deleted: { id: existing.id, name: existing.name } });
});

customAutomationsRouter.post('/:id/run', async (c) => {
  const result = await runCustomAutomationNow(c.req.param('id'));
  return c.json(result, result.outcome === 'failed' ? 400 : 200);
});
