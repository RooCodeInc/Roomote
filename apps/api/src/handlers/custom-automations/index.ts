import { Hono } from 'hono';
import type { Context } from 'hono';
import { z } from 'zod';

import {
  and,
  db,
  deleteCustomAutomation,
  eq,
  getCustomAutomationById,
  isNull,
  listCustomAutomations,
  users,
} from '@roomote/db/server';
import {
  createCustomAutomationWrite,
  CustomAutomationWriteError,
  resolveCustomAutomationSchedule,
  runCustomAutomationNow,
  updateCustomAutomationWrite,
  type CustomAutomationTargetWriteInput,
} from '@roomote/sdk/server';

import type { Variables } from '../../types';
import type { McpAuth } from '../mcp/middleware';
import { resolveActingUserIdOrNull } from '../mcp/proxy-utils';

type CustomAutomationVariables = Variables & {
  mcpAuth: McpAuth;
  customAutomationAdminId: string;
};

const modelSchema = z.string();

const writeSchema = z.object({
  name: z.string(),
  prompt: z.string(),
  enabled: z.boolean().default(true),
  schedule: z.string(),
  model: modelSchema.optional(),
  environmentId: z.string().uuid(),
  targetProvider: z.enum(['slack', 'discord', 'teams', 'telegram']).optional(),
  targetChannelId: z.string().optional(),
  targetServiceUrl: z.string().optional(),
});

const updateSchema = z.object({
  name: z.string().optional(),
  prompt: z.string().optional(),
  enabled: z.boolean().optional(),
  schedule: z.string().optional(),
  model: modelSchema.nullable().optional(),
  environmentId: z.string().uuid().optional(),
  targetProvider: z
    .enum(['slack', 'discord', 'teams', 'telegram'])
    .nullable()
    .optional(),
  targetChannelId: z.string().optional(),
  targetServiceUrl: z.string().nullable().optional(),
});

/**
 * Translate stable domain failures while leaving unexpected failures on the
 * app-level logged 500 path.
 */
function knownErrorResponse(
  c: Pick<Context, 'json'>,
  error: unknown,
): Response | null {
  if (error instanceof CustomAutomationWriteError) {
    return c.json(
      { error: error.message, code: error.code },
      error.code === 'not_found' ? 404 : 400,
    );
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

function targetInput(
  input: Pick<
    z.infer<typeof updateSchema>,
    'targetProvider' | 'targetChannelId' | 'targetServiceUrl'
  >,
): CustomAutomationTargetWriteInput | null | undefined {
  if (input.targetProvider === null) return null;
  if (
    input.targetProvider === undefined &&
    input.targetChannelId === undefined &&
    input.targetServiceUrl === undefined
  ) {
    return undefined;
  }
  return {
    ...(input.targetProvider ? { provider: input.targetProvider } : {}),
    ...(input.targetChannelId !== undefined
      ? { channelId: input.targetChannelId }
      : {}),
    ...(input.targetServiceUrl !== undefined
      ? { serviceUrl: input.targetServiceUrl }
      : {}),
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
    const result = await createCustomAutomationWrite({
      name: parsed.data.name,
      prompt: parsed.data.prompt,
      enabled: parsed.data.enabled,
      model: parsed.data.model ?? null,
      environmentId: parsed.data.environmentId,
      schedule: { schedule: parsed.data.schedule, userId: adminId(c) },
      target: targetInput(parsed.data) ?? null,
      createdByUserId: adminId(c),
    });
    if (result.status === 'ambiguous') return c.json(result, 409);
    return c.json(
      { automation: result.automation, resolution: result.resolution },
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
  try {
    const result = await updateCustomAutomationWrite(c.req.param('id'), {
      name: parsed.data.name,
      prompt: parsed.data.prompt,
      enabled: parsed.data.enabled,
      model: parsed.data.model,
      environmentId: parsed.data.environmentId,
      schedule:
        parsed.data.schedule !== undefined
          ? { schedule: parsed.data.schedule, userId: adminId(c) }
          : undefined,
      target: targetInput(parsed.data),
    });
    if (result.status === 'ambiguous') return c.json(result, 409);
    return c.json({
      automation: result.automation,
      resolution: result.resolution,
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
  return c.json({ deleted: { id: existing.id, name: existing.name } });
});

customAutomationsRouter.post('/:id/run', async (c) => {
  const result = await runCustomAutomationNow(c.req.param('id'));
  return c.json(result, result.outcome === 'failed' ? 400 : 200);
});
