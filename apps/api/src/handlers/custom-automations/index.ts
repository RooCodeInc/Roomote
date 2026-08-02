import { Hono } from 'hono';
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
  input: z.infer<typeof writeSchema>,
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
  return c.json(
    await resolveCustomAutomationSchedule({
      schedule: parsed.data.schedule,
      userId: adminId(c),
    }),
  );
});

customAutomationsRouter.post('/', async (c) => {
  const parsed = writeSchema.safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
  const schedule = await resolveWriteSchedule(parsed.data.schedule, adminId(c));
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
});

customAutomationsRouter.patch('/:id', async (c) => {
  const parsed = writeSchema.safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
  if (!(await getCustomAutomationById(c.req.param('id')))) {
    return c.json({ error: 'Custom automation was not found.' }, 404);
  }
  const schedule = await resolveWriteSchedule(parsed.data.schedule, adminId(c));
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
  const automation = await updateCustomAutomation(c.req.param('id'), {
    name: parsed.data.name,
    prompt: parsed.data.prompt,
    enabled: parsed.data.enabled,
    scheduleMode: schedule.scheduleMode,
    cronExpression: schedule.cronExpression,
    environmentId: parsed.data.environmentId,
    target: buildTarget(parsed.data),
  });
  return c.json({ automation, resolution: schedule.resolution });
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
