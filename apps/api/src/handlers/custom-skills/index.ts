import { Hono } from 'hono';
import { z } from 'zod';

import {
  and,
  createEnvironmentManualSkill,
  db,
  EnvironmentManualSkillValidationError,
  eq,
  isNull,
  users,
} from '@roomote/db/server';
import { Env } from '@roomote/env';
import { environmentManualSkillSchema } from '@roomote/types';

import type { Variables } from '../../types';
import type { McpAuth } from '../mcp/middleware';
import { resolveActingUserIdOrNull } from '../mcp/proxy-utils';

const createSkillSchema = environmentManualSkillSchema
  .extend({ environmentIds: z.array(z.string().uuid()).min(1) })
  .strict();

export const customSkillsRouter = new Hono<{
  Variables: Variables & { mcpAuth: McpAuth };
}>();

customSkillsRouter.post('/', async (c) => {
  const auth = c.get('mcpAuth');
  let userId: string | null;
  try {
    userId = await resolveActingUserIdOrNull({
      userId: auth.userId ?? null,
      tokenType: auth.authContext.tokenType,
      ...('runId' in auth.authContext ? { runId: auth.authContext.runId } : {}),
    });
  } catch {
    return c.json({ error: 'Admin access required' }, 403);
  }
  if (!userId) return c.json({ error: 'Admin access required' }, 403);

  const admin = await db.query.users.findFirst({
    where: and(
      eq(users.id, userId),
      eq(users.role, 'admin'),
      isNull(users.deletedAt),
    ),
    columns: { id: true },
  });
  if (!admin) return c.json({ error: 'Admin access required' }, 403);

  const parsed = createSkillSchema.safeParse(
    await c.req.json().catch(() => null),
  );
  if (!parsed.success) return c.json({ error: parsed.error.message }, 400);

  const settingsUrl = new URL('/settings/skills', Env.R_APP_URL).toString();
  try {
    const result = await createEnvironmentManualSkill(parsed.data);
    return c.json(
      {
        ...result,
        name: parsed.data.name,
        invocation: `$${parsed.data.name}`,
        settingsUrl,
        note: 'Available to new tasks in the selected environments. The current session is not updated.',
      },
      201,
    );
  } catch (error) {
    if (error instanceof EnvironmentManualSkillValidationError) {
      return c.json({ error: error.message }, 400);
    }
    throw error;
  }
});
