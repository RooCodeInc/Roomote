import type { Context } from 'hono';
import { z } from 'zod';

import { db, isBrainEnabled, saveBrainAgentSummary } from '@roomote/db/server';
import { TASK_MEMORY_LIMITS } from '@roomote/types';

import type { Variables } from '../../types';
import type { McpAuth } from '../mcp/middleware';
import { isRunTokenContext } from '../mcp/proxy-utils';
import { logHandlerError } from '../utils';

/**
 * Field caps keep one task's memory proportionate: a memory is a distillation
 * for future agents, not a transcript. The numbers live in TASK_MEMORY_LIMITS
 * so the worker tool schema advertises the same caps the server enforces.
 */
const memoryList = z
  .array(z.string().trim().min(1).max(TASK_MEMORY_LIMITS.listEntryMaxChars))
  .max(TASK_MEMORY_LIMITS.listMaxEntries);

const taskMemorySchema = z.object({
  outcome: z.string().trim().min(1).max(TASK_MEMORY_LIMITS.outcomeMaxChars),
  decisions: memoryList.optional(),
  rationale: z
    .string()
    .trim()
    .max(TASK_MEMORY_LIMITS.rationaleMaxChars)
    .optional(),
  reusableFacts: memoryList.optional(),
  unresolvedQuestions: memoryList.optional(),
});

/** One line per violation, naming the field, so the agent can fix its call. */
export function describeTaskMemoryIssues(
  issues: z.ZodIssue[],
  input: unknown,
): string {
  return issues
    .map((issue) => {
      const path = issue.path.join('.') || 'body';
      if (issue.code === 'too_big') {
        const value = issue.path.reduce<unknown>(
          (acc, key) =>
            acc && typeof acc === 'object'
              ? (acc as Record<string | number, unknown>)[key]
              : undefined,
          input,
        );
        const actual =
          typeof value === 'string'
            ? `${value.length} characters`
            : Array.isArray(value)
              ? `${value.length} entries`
              : undefined;
        return `${path}: at most ${issue.maximum} ${issue.type === 'array' ? 'entries' : 'characters'}${actual ? ` (got ${actual})` : ''}`;
      }
      return `${path}: ${issue.message}`;
    })
    .join('; ');
}

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

  if (!(await isBrainEnabled())) {
    return c.json(
      { saved: false, reason: 'This deployment has no Brain configured.' },
      200,
    );
  }

  const body: unknown = await c.req.json().catch(() => null);
  const parsed = taskMemorySchema.safeParse(body);

  if (!parsed.success) {
    return c.json(
      {
        error: `Invalid task memory: ${describeTaskMemoryIssues(parsed.error.issues, body)}`,
        issues: parsed.error.issues,
      },
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
