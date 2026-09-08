import { Hono } from 'hono';
import { ZodError } from 'zod';
import { createCustomSkill, CreateCustomSkillError } from '@roomote/db/server';
import { createCustomSkillInputSchema } from '@roomote/types';
import type { Variables } from '../../types';
import type { McpAuth } from '../mcp/middleware';
import { resolveActingUserIdOrNull } from '../mcp/proxy-utils';

export const customSkillsRouter = new Hono<{
  Variables: Variables & { mcpAuth: McpAuth };
}>();

customSkillsRouter.post('/', async (c) => {
  const auth = c.get('mcpAuth');
  let actorUserId: string | null = null;
  try {
    actorUserId = await resolveActingUserIdOrNull({
      userId: auth.userId ?? null,
      tokenType: auth.authContext.tokenType,
      ...('runId' in auth.authContext ? { runId: auth.authContext.runId } : {}),
    });
  } catch {
    return c.json({ error: 'Active member access required' }, 403);
  }
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
    if (error instanceof CreateCustomSkillError)
      return c.json({ error: error.message }, error.status);
    if (error instanceof ZodError)
      return c.json({ error: 'Invalid skill.' }, 400);
    throw error;
  }
});
