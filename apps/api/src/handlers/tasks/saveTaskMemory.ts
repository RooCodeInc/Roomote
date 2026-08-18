import type { Context } from 'hono';
import { z } from 'zod';

import {
  db,
  isBrainProviderConfigured,
  saveBrainAgentSummary,
} from '@roomote/db/server';

import type { Variables } from '../../types';
import type { McpAuth } from '../mcp/middleware';
import { isRunTokenContext } from '../mcp/proxy-utils';
import { logHandlerError } from '../utils';

/**
 * Field caps keep one task's memory proportionate: a memory is a distillation
 * for future agents, not a transcript.
 */
const taskMemorySchema = z.object({
  outcome: z.string().trim().min(1).max(2_000),
  decisions: z.array(z.string().trim().min(1).max(1_000)).max(20).optional(),
  rationale: z.string().trim().max(2_000).optional(),
  reusableFacts: z
    .array(z.string().trim().min(1).max(1_000))
    .max(20)
    .optional(),
  unresolvedQuestions: z
    .array(z.string().trim().min(1).max(1_000))
    .max(20)
    .optional(),
});

function renderAgentSummary(input: z.infer<typeof taskMemorySchema>): string {
  const section = (title: string, lines: string[]) =>
    lines.length > 0
      ? [`## ${title}`, '', ...lines.map((l) => `- ${l}`), '']
      : [];

  return [
    '## Outcome',
    '',
    input.outcome,
    '',
    ...(input.rationale ? ['## Why', '', input.rationale, ''] : []),
    ...section('Decisions', input.decisions ?? []),
    ...section('Reusable facts', input.reusableFacts ?? []),
    ...section('Open questions', input.unresolvedQuestions ?? []),
  ]
    .join('\n')
    .trim();
}

/**
 * Agent-authored task memory. The agent supplies the narrative it is uniquely
 * positioned to write (what it decided and why); the server owns placement:
 * the text is parked on this run's outbox row and the ingestion drainer
 * writes it into the Brain under a server-chosen slug, after deterministic
 * redaction. An agent therefore cannot write to any page but its own task's,
 * and never reaches the Brain directly.
 */
export async function saveTaskMemory(
  c: Context<{ Variables: Variables & { mcpAuth: McpAuth } }>,
): Promise<Response> {
  const auth = c.get('mcpAuth').authContext;

  if (!isRunTokenContext(auth)) {
    return c.json({ error: 'Task memory requires a task run token' }, 403);
  }

  const runId = Number(c.req.param('runId'));

  if (!Number.isInteger(runId) || runId <= 0) {
    return c.json({ error: 'Invalid task run id' }, 400);
  }

  if (auth.runId !== runId) {
    return c.json(
      { error: 'Task run token does not match requested task run' },
      403,
    );
  }

  if (!(await isBrainProviderConfigured())) {
    return c.json(
      { saved: false, reason: 'This deployment has no Brain configured.' },
      200,
    );
  }

  const parsed = taskMemorySchema.safeParse(
    await c.req.json().catch(() => null),
  );

  if (!parsed.success) {
    return c.json(
      { error: 'Invalid task memory', issues: parsed.error.issues },
      400,
    );
  }

  try {
    await saveBrainAgentSummary(db, runId, renderAgentSummary(parsed.data));

    return c.json({ saved: true });
  } catch (error) {
    logHandlerError('saveTaskMemory', error);
    return c.json({ error: 'Failed to save task memory' }, 500);
  }
}
