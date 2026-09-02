import type { Context } from 'hono';

import {
  createComputeProviderClient,
  getComputeProviderCapabilities,
} from '@roomote/compute-providers';
import {
  and,
  asc,
  db,
  eq,
  resolveComputeProviderEnvValues,
  taskRuns,
  tasks,
} from '@roomote/db/server';
import { isComputeProvider, type ComputeProvider } from '@roomote/types';

import type { Variables } from '../../types';
import type { McpAuth } from '../mcp/middleware';
import { logHandlerError } from '../utils';
import { visibleTaskHistoryCondition } from './helpers';

interface TaskRunLogRow {
  id: number;
  status: string;
  vendor: string | null;
  machineId: string | null;
  sandboxCmdId: string | null;
  log: string | null;
}

interface ResolvedTaskRunProvider {
  provider: ComputeProvider | null;
  responseVendor: string;
}

function resolveTaskRunProvider(job: TaskRunLogRow): ResolvedTaskRunProvider {
  if (!job.vendor) {
    return { provider: 'docker', responseVendor: 'docker' };
  }

  if (isComputeProvider(job.vendor)) {
    return { provider: job.vendor, responseVendor: job.vendor };
  }

  return { provider: null, responseVendor: job.vendor };
}

function getSkippedReason(
  job: TaskRunLogRow,
  providerInfo: ResolvedTaskRunProvider,
): string | null {
  if (!providerInfo.provider) {
    return `unsupported_provider:${providerInfo.responseVendor}`;
  }

  const provider = providerInfo.provider;
  const capabilities = getComputeProviderCapabilities(provider);

  if (!capabilities.supportsCommandOutputLookup) {
    return `unsupported_command_output_lookup:${providerInfo.responseVendor}`;
  }

  if (!job.machineId && !job.sandboxCmdId) {
    return 'missing_machine_id_and_sandbox_cmd_id';
  }

  if (!job.machineId) {
    return 'missing_machine_id';
  }

  if (!job.sandboxCmdId) {
    return 'missing_sandbox_cmd_id';
  }

  return null;
}

/**
 * GET /api/mcp/tasks/:taskId/compute_logs
 *
 * Get the compute/runtime logs for every task run tied to a task and fetch
 * provider command output for jobs whose compute provider supports output
 * lookup and that have both a machine id and sandbox command id.
 */
export async function getTaskComputeLogs(
  c: Context<{ Variables: Variables & { mcpAuth: McpAuth } }>,
): Promise<Response> {
  const taskId = c.req.param('taskId');

  if (!taskId) {
    return c.json({ error: 'taskId is required' }, 400);
  }

  try {
    const [task] = await db
      .select({ id: tasks.id })
      .from(tasks)
      .where(and(eq(tasks.id, taskId), visibleTaskHistoryCondition))
      .limit(1);

    if (!task) {
      return c.json({ error: 'Task not found' }, 404);
    }

    const jobs = await db.query.taskRuns.findMany({
      where: eq(taskRuns.taskId, taskId),
      columns: {
        id: true,
        status: true,
        vendor: true,
        machineId: true,
        sandboxCmdId: true,
        log: true,
      },
      orderBy: [asc(taskRuns.createdAt), asc(taskRuns.id)],
    });

    const clientCache = new Map<
      ComputeProvider,
      ReturnType<typeof createComputeProviderClient>
    >();
    const clientErrorCache = new Map<ComputeProvider, string>();

    const result = await Promise.all(
      jobs.map(async (job) => {
        const providerInfo = resolveTaskRunProvider(job);
        const skippedReason = getSkippedReason(job, providerInfo);
        const provider = providerInfo.provider;
        const responseVendor = providerInfo.responseVendor;

        if (provider === 'roomote') {
          if (job.log?.trim()) {
            return {
              id: job.id,
              status: job.status,
              vendor: responseVendor,
              machineId: job.machineId,
              sandboxCmdId: job.sandboxCmdId,
              output: job.log,
              skippedReason: null,
              error: null,
            };
          }

          return {
            id: job.id,
            status: job.status,
            vendor: responseVendor,
            machineId: job.machineId,
            sandboxCmdId: job.sandboxCmdId,
            output: null,
            skippedReason: 'no_retained_output:roomote',
            error: null,
          };
        }

        if (skippedReason) {
          return {
            id: job.id,
            status: job.status,
            vendor: responseVendor,
            machineId: job.machineId,
            sandboxCmdId: job.sandboxCmdId,
            output: null,
            skippedReason,
            error: null,
          };
        }

        try {
          if (!provider) {
            throw new Error(`Unsupported provider: ${responseVendor}`);
          }

          let client = clientCache.get(provider);

          if (!client && !clientErrorCache.has(provider)) {
            try {
              client = createComputeProviderClient({
                provider,
                envFallback: await resolveComputeProviderEnvValues(provider),
              });
              clientCache.set(provider, client);
            } catch (error) {
              clientErrorCache.set(
                provider,
                error instanceof Error ? error.message : String(error),
              );
            }
          }

          const clientError = clientErrorCache.get(provider);

          if (clientError) {
            throw new Error(clientError);
          }

          client ??= clientCache.get(provider);

          const output = await client!.getCommandOutput({
            commandId: job.sandboxCmdId!,
            instanceId: job.machineId!,
            signal: c.req.raw.signal,
          });

          return {
            id: job.id,
            status: job.status,
            vendor: responseVendor,
            machineId: job.machineId,
            sandboxCmdId: job.sandboxCmdId,
            output,
            skippedReason: null,
            error: null,
          };
        } catch (error) {
          return {
            id: job.id,
            status: job.status,
            vendor: responseVendor,
            machineId: job.machineId,
            sandboxCmdId: job.sandboxCmdId,
            output: null,
            skippedReason: null,
            error: error instanceof Error ? error.message : String(error),
          };
        }
      }),
    );

    return c.json({
      taskId,
      returned: result.length,
      taskRuns: result,
    });
  } catch (error) {
    logHandlerError('getTaskComputeLogs', error);
    return c.json({ error: 'Failed to get task compute logs' }, 500);
  }
}
