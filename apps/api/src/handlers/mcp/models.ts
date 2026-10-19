import type { Context } from 'hono';
import { z } from 'zod';
import { getDeploymentTaskModelOptions } from '@roomote/db/server';

import type { Variables } from '../../types';
import { resolveRoomoteMemberAuth } from './roomote-member-auth';
import { McpProxyError } from './proxy-utils';
import { logHandlerError } from '../utils';

const cursorSchema = z
  .object({
    after: z.string().min(1).max(1024),
    query: z.string().max(200),
  })
  .strict();

/** Account-authorized discovery of the enabled deployment catalog. */
export async function listMemberModels(c: Context<{ Variables: Variables }>) {
  c.header('Cache-Control', 'no-store, private');
  try {
    resolveRoomoteMemberAuth(c.get('authContext'));
  } catch (error) {
    if (error instanceof McpProxyError)
      return Response.json(
        { error: error.message },
        { status: error.httpStatus },
      );
    throw error;
  }

  const rawLimit = c.req.query('limit') ?? '50';
  const limit = Number(rawLimit);
  if (
    !/^\d+$/.test(rawLimit) ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 100
  )
    return c.json({ error: 'limit must be an integer from 1 to 100' }, 400);
  const query = (c.req.query('query') ?? '').trim().toLowerCase();
  if (query.length > 200)
    return c.json({ error: 'query must be at most 200 characters' }, 400);

  let after: string | undefined;
  const cursor = c.req.query('cursor');
  if (cursor !== undefined) {
    try {
      if (cursor.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(cursor))
        throw new Error();
      const parsed = cursorSchema.parse(
        JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')),
      );
      if (parsed.query !== query) throw new Error();
      after = parsed.after;
    } catch {
      return c.json(
        { error: 'Invalid cursor; use nextCursor with the same query' },
        400,
      );
    }
  }

  try {
    const { models, defaultModelId } = await getDeploymentTaskModelOptions();
    const matching = models
      .filter(
        (model) =>
          (!after || model.id > after) &&
          [model.id, model.displayName, model.family].some((value) =>
            value.toLowerCase().includes(query),
          ),
      )
      .sort((left, right) =>
        left.id < right.id ? -1 : left.id > right.id ? 1 : 0,
      );
    const page = matching.slice(0, limit);
    const last = page.at(-1);
    return c.json({
      models: page.map((model) => ({
        id: model.id,
        displayName: model.displayName,
        family: model.family,
        metadata: model.metadata ?? null,
        isDefault: model.id === defaultModelId,
      })),
      defaultModelId,
      nextCursor:
        matching.length > limit && last
          ? Buffer.from(JSON.stringify({ after: last.id, query })).toString(
              'base64url',
            )
          : null,
    });
  } catch (error) {
    logHandlerError('listMemberModels', error);
    return c.json({ error: 'Failed to list models' }, 500);
  }
}
