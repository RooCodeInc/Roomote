import { Hono, type Context } from 'hono';
import { ZodError } from 'zod';
import {
  createCustomSkill,
  CreateCustomSkillError,
  updateCustomSkillFromAgent,
} from '@roomote/db/server';
import {
  createCustomSkillInputSchema,
  updateCustomSkillInputSchema,
} from '@roomote/types';
import type { Variables } from '../../types';
import type { McpAuth } from '../mcp/middleware';
import { resolveActingUserIdOrNull } from '../mcp/proxy-utils';

type CustomSkillsEnv = {
  Variables: Variables & { mcpAuth: McpAuth };
};

export const customSkillsRouter = new Hono<CustomSkillsEnv>();

async function actingUserId(c: Context<CustomSkillsEnv>) {
  const auth = c.get('mcpAuth');
  try {
    return await resolveActingUserIdOrNull({
      userId: auth.userId ?? null,
      tokenType: auth.authContext.tokenType,
      ...('runId' in auth.authContext ? { runId: auth.authContext.runId } : {}),
    });
  } catch {
    return null;
  }
}

function skillError(c: Context<CustomSkillsEnv>, error: unknown) {
  if (error instanceof CreateCustomSkillError)
    return c.json({ error: error.message }, error.status);
  if (error instanceof ZodError)
    return c.json({ error: 'Invalid skill.' }, 400);
  throw error;
}

customSkillsRouter.post('/', async (c) => {
  const actorUserId = await actingUserId(c);
  if (!actorUserId)
    return c.json({ error: 'Active member access required' }, 403);
  const body = await c.req.json().catch(() => null);
  const parsed = createCustomSkillInputSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
  try {
    return c.json(
      await createCustomSkill({ ...parsed.data, actorUserId }),
      201,
    );
  } catch (error) {
    return skillError(c, error);
  }
});

customSkillsRouter.patch('/', async (c) => {
  const actorUserId = await actingUserId(c);
  if (!actorUserId)
    return c.json({ error: 'Active member access required' }, 403);
  const body = await c.req.json().catch(() => null);
  const parsed = updateCustomSkillInputSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
  try {
    return c.json(
      await updateCustomSkillFromAgent({ ...parsed.data, actorUserId }),
    );
  } catch (error) {
    return skillError(c, error);
  }
});
