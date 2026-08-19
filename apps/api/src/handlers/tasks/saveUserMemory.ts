import { createHash } from 'node:crypto';

import type { Context } from 'hono';
import { z } from 'zod';

import { callBrainTool, resolveBrainConnection } from '@roomote/sdk/server';
import { brainNamespacePrefix, redactBrainText } from '@roomote/types';

import type { Variables } from '../../types';
import type { McpAuth } from '../mcp/middleware';
import { isRunTokenContext } from '../mcp/proxy-utils';
import { logHandlerError } from '../utils';

const userMemorySchema = z.object({
  key: z.string().trim().min(1).max(100),
  value: z.string().trim().min(1).max(2_000),
  source: z.object({ surface: z.enum(['slack', 'discord']) }).optional(),
});

function normalizeMemoryKey(key: string): string {
  return key
    .normalize('NFKC')
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, ' ');
}

function buildUserMemoryPage(input: {
  userId: string;
  key: string;
  value: string;
  sourceSurface?: 'slack' | 'discord';
  updatedAt?: Date;
}): { slug: string; content: string } {
  const normalizedKey = normalizeMemoryKey(input.key);
  const keyHash = createHash('sha256').update(normalizedKey).digest('hex');
  const encodedUserId = Buffer.from(input.userId).toString('base64url');
  const updatedAt = (input.updatedAt ?? new Date()).toISOString();
  const content = [
    '---',
    `roomote_user_id: ${JSON.stringify(input.userId)}`,
    `memory_key: ${JSON.stringify(normalizedKey)}`,
    'provenance: roomote-fast-user-memory',
    ...(input.sourceSurface
      ? [`source_surface: ${JSON.stringify(input.sourceSurface)}`]
      : []),
    `updated_at: ${updatedAt}`,
    '---',
    '',
    '# User memory',
    '',
    `- Key: ${input.key}`,
    `- Value: ${input.value}`,
  ].join('\n');

  return {
    slug: `${brainNamespacePrefix('memories')}users/${encodedUserId}/${keyHash}`,
    content: redactBrainText(content),
  };
}

/**
 * Persist one authenticated user's explicit fact or preference. The caller
 * chooses only a semantic key and value; Roomote owns identity, placement,
 * provenance, redaction, and the deterministic upsert slug.
 */
export async function saveUserMemory(
  c: Context<{ Variables: Variables & { mcpAuth: McpAuth } }>,
): Promise<Response> {
  const auth = c.get('mcpAuth');

  if (!auth.userId || isRunTokenContext(auth.authContext)) {
    return c.json({ error: 'User memory requires an authenticated user' }, 403);
  }

  const parsed = userMemorySchema.safeParse(
    await c.req.json().catch(() => null),
  );
  if (!parsed.success) {
    return c.json(
      { error: 'Invalid user memory', issues: parsed.error.issues },
      400,
    );
  }

  try {
    const connection = await resolveBrainConnection('ingest');
    if (!connection) {
      return c.json({ error: 'This deployment has no Brain configured.' }, 503);
    }

    const page = buildUserMemoryPage({
      userId: auth.userId,
      key: parsed.data.key,
      value: parsed.data.value,
      sourceSurface: parsed.data.source?.surface,
    });
    await callBrainTool(connection, 'put_page', page);

    return c.json({ saved: true });
  } catch (error) {
    logHandlerError('saveUserMemory', error);
    return c.json({ error: 'Failed to save user memory' }, 500);
  }
}
