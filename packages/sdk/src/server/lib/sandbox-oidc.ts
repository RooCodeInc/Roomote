import { randomUUID } from 'node:crypto';
import path from 'node:path';

import {
  SANDBOX_OIDC_REFRESH_BUFFER_MS,
  SANDBOX_OIDC_TOKEN_TTL_MS,
  createSandboxOidcToken,
  isSandboxOidcConfigured,
} from '@roomote/auth';
import { createComputeProviderClient } from '@roomote/compute-providers';
import {
  type EnvironmentConfig,
  type ComputeProvider,
  type ResolvedEnvironmentOidcTarget,
  CloudTaskStatus,
  extractErrorDetails,
  getEnvironmentOidcTargets,
  isObservedTimeoutError,
  serializeError,
  wrapObservedTimeoutError,
} from '@roomote/types';
import {
  and,
  cloudJobs,
  recordCloudJobEvent,
  createRowMapper,
  db,
  environments,
  eq,
  inArray,
  sandboxOidcTargets,
  sql,
} from '@roomote/db/server';

const SANDBOX_OIDC_REFRESH_CLAIM_DELAY_MS = 2 * 60 * 1000;
const SANDBOX_OIDC_REFRESH_MACHINE_BATCH_SIZE = 50;
const SANDBOX_OIDC_REFRESH_CONCURRENCY = 5;
const SANDBOX_OIDC_STATUS_SNAPSHOT_TIMEOUT_MS = 2_000;
const SANDBOX_OIDC_RETRY_DELAY_MS = 1_000;
const SANDBOX_OIDC_TIMEOUT_MAX_ATTEMPTS = 2;
const SANDBOX_OIDC_WRITE_TIMEOUT_MS = 60_000;
const SANDBOX_OIDC_COMMAND_TIMEOUT_MS = 60_000;

type SandboxOidcTargetRow = typeof sandboxOidcTargets.$inferSelect;
type SandboxOidcTargetInsert = typeof sandboxOidcTargets.$inferInsert;

type PrimeSandboxOidcTargetsInput = {
  taskId?: string;
  environmentId: string;
  environmentConfig: EnvironmentConfig;
  computeProvider: ComputeProvider;
  computeProviderId: string;
  cloudJobId?: number;
  now?: Date;
};

type OwnerState = {
  taskId?: string;
  environmentId: string;
  environmentConfig: EnvironmentConfig;
  cloudJobId?: number;
} | null;

type RefreshMachineResult =
  | { status: 'refreshed' }
  | { status: 'cleaned' }
  | { status: 'failed'; error: unknown };

type SandboxOidcStepDetails = {
  phase: 'prime_targets';
  operation: 'write_files' | 'install_token_files';
  computeProvider: ComputeProvider;
  computeProviderId: string;
  environmentId: string;
  targetCount: number;
  tokenFiles: string[];
  staleFileCount: number;
  timeoutMs: number;
  attempt?: number;
  maxAttempts?: number;
  retryable?: boolean;
  durationMs?: number;
  instanceStatusSnapshot?: Record<string, unknown>;
  error?: Record<string, unknown>;
};

class SandboxOidcCommandExitError extends Error {
  public readonly exitCode: number;
  public readonly context: { exitCode: number };

  constructor(params: {
    computeProvider: ComputeProvider;
    computeProviderId: string;
    message: string;
    exitCode: number;
  }) {
    super(
      `Failed to install sandbox OIDC token files on ${params.computeProvider}:${params.computeProviderId}: ${params.message}`,
    );
    this.name = 'SandboxOidcCommandExitError';
    this.exitCode = params.exitCode;
    this.context = { exitCode: params.exitCode };
  }
}

const sandboxOidcTargetRowMapper =
  createRowMapper<SandboxOidcTargetRow>(sandboxOidcTargets);

function shellEscape(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function assertSandboxOidcAvailable(): void {
  if (!isSandboxOidcConfigured()) {
    throw new Error(
      'Sandbox OIDC is not configured. Set SANDBOX_OIDC_PRIVATE_KEY and SANDBOX_OIDC_PUBLIC_KEY.',
    );
  }
}

function buildAtomicInstallScript(params: {
  installs: Array<{
    tempPath: string;
    targetFile: string;
    stagedPath: string;
  }>;
  staleFiles: string[];
}): string {
  const lines = ['set -eu'];

  for (const install of params.installs) {
    lines.push(
      `mkdir -p ${shellEscape(path.posix.dirname(install.targetFile))}`,
    );
    lines.push(
      `install -m 600 ${shellEscape(install.tempPath)} ${shellEscape(
        install.stagedPath,
      )}`,
    );
    lines.push(
      `mv ${shellEscape(install.stagedPath)} ${shellEscape(install.targetFile)}`,
    );
    lines.push(`rm -f ${shellEscape(install.tempPath)}`);
  }

  if (params.staleFiles.length > 0) {
    lines.push(
      `rm -f -- ${params.staleFiles.map((file) => shellEscape(file)).join(' ')}`,
    );
  }

  return lines.join('\n');
}

function buildTargetRows(params: {
  now: Date;
  environmentId: string;
  computeProvider: ComputeProvider;
  computeProviderId: string;
  cloudJobId?: number;
  targets: ResolvedEnvironmentOidcTarget[];
}): SandboxOidcTargetInsert[] {
  const expiresAt = new Date(params.now.getTime() + SANDBOX_OIDC_TOKEN_TTL_MS);
  const refreshAt = new Date(
    expiresAt.getTime() - SANDBOX_OIDC_REFRESH_BUFFER_MS,
  );

  return params.targets.map((target) => ({
    environmentId: params.environmentId,
    cloudJobId: params.cloudJobId ?? null,
    computeProvider: params.computeProvider,
    computeProviderId: params.computeProviderId,
    targetKind: target.kind,
    audience: target.audience,
    tokenFile: target.tokenFile,
    awsRoleArn: target.roleArn ?? null,
    awsRegion: target.region ?? null,
    refreshAt,
    expiresAt,
    updatedAt: params.now,
  }));
}

function groupRowsByInstance(
  rows: SandboxOidcTargetRow[],
): Map<string, SandboxOidcTargetRow[]> {
  const groups = new Map<string, SandboxOidcTargetRow[]>();

  for (const row of rows) {
    const key = [
      row.computeProvider,
      row.computeProviderId,
      row.cloudJobId ?? 'none',
      row.environmentId,
    ].join(':');
    const entries = groups.get(key) ?? [];
    entries.push(row);
    groups.set(key, entries);
  }

  return groups;
}

function getFirstRow(rows: SandboxOidcTargetRow[]): SandboxOidcTargetRow {
  const first = rows[0];

  if (!first) {
    throw new Error('Expected at least one sandbox OIDC target row.');
  }

  return first;
}

function isRetryableSandboxOidcError(error: unknown): boolean {
  if (isObservedTimeoutError(error)) {
    return true;
  }

  const { name } = serializeError(error);
  return name === 'TimeoutError' || name === 'AbortError';
}

async function runSandboxOidcOperationWithRetry<T>(params: {
  computeProvider: ComputeProvider;
  computeProviderId: string;
  operation: string;
  timeoutMs: number;
  execute: (signal: AbortSignal) => Promise<T>;
  beforeRetry?: (nextAttempt: number) => Promise<void>;
  onAttemptStart?: (details: {
    attempt: number;
    maxAttempts: number;
  }) => Promise<void>;
  onAttemptSuccess?: (details: {
    attempt: number;
    maxAttempts: number;
    durationMs: number;
  }) => Promise<void>;
  onAttemptFailure?: (details: {
    attempt: number;
    maxAttempts: number;
    durationMs: number;
    error: Error;
    retryable: boolean;
  }) => Promise<void>;
}): Promise<T> {
  for (
    let attempt = 1;
    attempt <= SANDBOX_OIDC_TIMEOUT_MAX_ATTEMPTS;
    attempt += 1
  ) {
    const startedAt = Date.now();
    const signal = AbortSignal.timeout(params.timeoutMs);

    try {
      await params.onAttemptStart?.({
        attempt,
        maxAttempts: SANDBOX_OIDC_TIMEOUT_MAX_ATTEMPTS,
      });

      const result = await params.execute(signal);

      await params.onAttemptSuccess?.({
        attempt,
        maxAttempts: SANDBOX_OIDC_TIMEOUT_MAX_ATTEMPTS,
        durationMs: Date.now() - startedAt,
      });

      return result;
    } catch (error) {
      const durationMs = Date.now() - startedAt;
      const wrappedError = wrapObservedTimeoutError({
        error,
        signal,
        details: {
          source: 'Vercel Sandbox',
          operation: params.operation,
          durationMs,
          timeoutMs: params.timeoutMs,
        },
      });

      const shouldRetry =
        attempt < SANDBOX_OIDC_TIMEOUT_MAX_ATTEMPTS &&
        isRetryableSandboxOidcError(wrappedError);

      await params.onAttemptFailure?.({
        attempt,
        maxAttempts: SANDBOX_OIDC_TIMEOUT_MAX_ATTEMPTS,
        durationMs,
        error: wrappedError,
        retryable: shouldRetry,
      });

      if (!shouldRetry) {
        throw wrappedError;
      }

      console.warn(
        `[sandbox-oidc] ${params.operation} failed for ${params.computeProvider}:${params.computeProviderId} on attempt ${attempt}/${SANDBOX_OIDC_TIMEOUT_MAX_ATTEMPTS}; retrying in ${SANDBOX_OIDC_RETRY_DELAY_MS}ms: ${
          serializeError(wrappedError).message
        }`,
      );

      await new Promise((resolve) =>
        setTimeout(resolve, SANDBOX_OIDC_RETRY_DELAY_MS),
      );

      await params.beforeRetry?.(attempt + 1);
    }
  }

  throw new Error(
    `Unreachable sandbox OIDC retry loop for ${params.computeProvider}:${params.computeProviderId}`,
  );
}

async function mapWithConcurrency<T, R>(
  values: T[],
  concurrency: number,
  mapper: (value: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (nextIndex < values.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      const value = values[currentIndex];

      if (value === undefined) {
        continue;
      }

      results[currentIndex] = await mapper(value);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, () =>
      worker(),
    ),
  );

  return results;
}

async function removeSandboxOidcFiles(params: {
  computeProvider: ComputeProvider;
  computeProviderId: string;
  tokenFiles: string[];
}): Promise<void> {
  if (params.tokenFiles.length === 0) {
    return;
  }

  const client = createComputeProviderClient({
    provider: params.computeProvider,
  });
  const script = `set -eu\nrm -f -- ${params.tokenFiles
    .map((file) => shellEscape(file))
    .join(' ')}`;
  const result = await client.runCommand({
    instanceId: params.computeProviderId,
    cmd: 'sh',
    args: ['-lc', script],
    signal: AbortSignal.timeout(SANDBOX_OIDC_COMMAND_TIMEOUT_MS),
  });

  if (result.exitCode !== 0) {
    throw new Error(
      `Failed to remove sandbox OIDC files from ${params.computeProvider}:${params.computeProviderId}: ${result.stderr ?? result.stdout ?? 'unknown error'}`,
    );
  }
}

async function isDeadOrMissingSandboxOidcInstance(params: {
  computeProvider: ComputeProvider;
  computeProviderId: string;
}): Promise<boolean> {
  const client = createComputeProviderClient({
    provider: params.computeProvider,
  });

  try {
    const status = await client.getInstanceStatus({
      instanceId: params.computeProviderId,
      signal: AbortSignal.timeout(SANDBOX_OIDC_COMMAND_TIMEOUT_MS),
    });

    return status.status === 'stopped' || status.status === 'failed';
  } catch (error) {
    if (isMissingInstanceStatusError(error)) {
      return true;
    }

    console.warn(
      `[sandbox-oidc] Failed to determine whether instance ${params.computeProvider}:${params.computeProviderId} is dead before sandbox OIDC cleanup: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return false;
  }
}

function isMissingInstanceStatusError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }

  const record = error as {
    message?: unknown;
    response?: { status?: unknown };
    cause?: unknown;
  };

  if (record.response?.status === 404) {
    return true;
  }

  if (
    typeof record.message === 'string' &&
    /\bnot found\b/i.test(record.message)
  ) {
    return true;
  }

  return isMissingInstanceStatusError(record.cause);
}

async function deleteRowsByIds(ids: string[]): Promise<void> {
  if (ids.length === 0) {
    return;
  }

  await db
    .delete(sandboxOidcTargets)
    .where(inArray(sandboxOidcTargets.id, ids));
}

async function loadOwnerStateForRefresh(
  row: SandboxOidcTargetRow,
): Promise<OwnerState> {
  const environment = await db.query.environments.findFirst({
    where: eq(environments.id, row.environmentId),
  });

  if (!environment) {
    return null;
  }

  if (row.cloudJobId) {
    const cloudJob = await db.query.cloudJobs.findFirst({
      where: eq(cloudJobs.id, row.cloudJobId),
      columns: {
        id: true,
        taskId: true,
        vendor: true,
        machineId: true,
        payload: true,
        status: true,
      },
    });

    if (!cloudJob) {
      return null;
    }

    if (
      cloudJob.status === CloudTaskStatus.Completed ||
      cloudJob.status === CloudTaskStatus.Failed ||
      cloudJob.status === CloudTaskStatus.Canceled
    ) {
      return null;
    }

    if (
      cloudJob.vendor !== row.computeProvider ||
      cloudJob.machineId !== row.computeProviderId
    ) {
      return null;
    }

    return {
      taskId: cloudJob.taskId,
      environmentId: row.environmentId,
      environmentConfig: environment.config,
      cloudJobId: row.cloudJobId,
    };
  }

  return null;
}

async function cleanupSandboxOidcRows(
  rows: SandboxOidcTargetRow[],
): Promise<void> {
  if (rows.length === 0) {
    return;
  }

  const tokenFiles = [...new Set(rows.map((row) => row.tokenFile))];
  const first = getFirstRow(rows);

  try {
    await removeSandboxOidcFiles({
      computeProvider: first.computeProvider,
      computeProviderId: first.computeProviderId,
      tokenFiles,
    });
  } catch (error) {
    console.warn(
      `[sandbox-oidc] Failed to remove token files for ${first.computeProvider}:${first.computeProviderId}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );

    const shouldDeleteRows = await isDeadOrMissingSandboxOidcInstance({
      computeProvider: first.computeProvider,
      computeProviderId: first.computeProviderId,
    });

    if (!shouldDeleteRows) {
      throw error;
    }
  }

  await deleteRowsByIds(rows.map((row) => row.id));
}

async function getSandboxOidcStatusSnapshot(params: {
  client: ReturnType<typeof createComputeProviderClient>;
  computeProviderId: string;
}): Promise<Record<string, unknown>> {
  try {
    const status = await params.client.getInstanceStatus({
      instanceId: params.computeProviderId,
      signal: AbortSignal.timeout(SANDBOX_OIDC_STATUS_SNAPSHOT_TIMEOUT_MS),
    });

    return {
      status: status.status,
      timeoutRemainingMs: status.timeoutRemainingMs ?? null,
    };
  } catch (error) {
    return {
      error: extractErrorDetails(error),
      timeoutMs: SANDBOX_OIDC_STATUS_SNAPSHOT_TIMEOUT_MS,
    };
  }
}

async function recordSandboxOidcEventSafe(params: {
  cloudJobId?: number;
  taskId?: string;
  eventType: 'started' | 'completed' | 'failed';
  message: string;
  details: SandboxOidcStepDetails;
}): Promise<void> {
  if (!params.cloudJobId) {
    return;
  }

  try {
    await recordCloudJobEvent(db, {
      cloudJobId: params.cloudJobId,
      taskId: params.taskId,
      source: 'machine_oidc',
      eventType: params.eventType,
      message: params.message,
      details: params.details,
    });
  } catch (error) {
    console.warn(
      `[sandbox-oidc] Failed to record machine_oidc event for cloud job #${params.cloudJobId}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

export async function primeSandboxOidcTargets(
  input: PrimeSandboxOidcTargetsInput,
): Promise<{ targetCount: number }> {
  const now = input.now ?? new Date();
  const targets = getEnvironmentOidcTargets(input.environmentConfig);

  if (targets.length === 0) {
    const existingRows = await db.query.sandboxOidcTargets.findMany({
      where: and(
        eq(sandboxOidcTargets.computeProvider, input.computeProvider),
        eq(sandboxOidcTargets.computeProviderId, input.computeProviderId),
      ),
    });

    if (existingRows.length > 0) {
      await cleanupSandboxOidcRows(existingRows);
    }

    return { targetCount: 0 };
  }

  assertSandboxOidcAvailable();

  const client = createComputeProviderClient({
    provider: input.computeProvider,
  });
  const existingRows = await db.query.sandboxOidcTargets.findMany({
    where: and(
      eq(sandboxOidcTargets.computeProvider, input.computeProvider),
      eq(sandboxOidcTargets.computeProviderId, input.computeProviderId),
    ),
  });
  const currentTokenFiles = new Set(targets.map((target) => target.tokenFile));
  const staleFiles = [
    ...new Set(
      existingRows
        .map((row) => row.tokenFile)
        .filter((tokenFile) => !currentTokenFiles.has(tokenFile)),
    ),
  ];

  const installs = targets.map((target) => {
    const tempPath = `/tmp/roomote-oidc-${randomUUID()}.jwt`;
    const stagedPath = `${target.tokenFile}.roomote-next-${randomUUID()}`;
    const token = createSandboxOidcToken({
      environmentId: input.environmentId,
      audience: target.audience,
      now,
    });

    return {
      target,
      tempPath,
      stagedPath,
      token,
    };
  });

  const tokenFiles = targets.map((target) => target.tokenFile);
  const baseDetails = {
    phase: 'prime_targets' as const,
    computeProvider: input.computeProvider,
    computeProviderId: input.computeProviderId,
    environmentId: input.environmentId,
    targetCount: targets.length,
    tokenFiles,
    staleFileCount: staleFiles.length,
  };

  const writeTempFiles = (signal: AbortSignal) =>
    client.writeFiles({
      instanceId: input.computeProviderId,
      files: installs.map((install) => ({
        path: install.tempPath,
        content: Buffer.from(install.token, 'utf-8'),
      })),
      signal,
    });

  const writeStatusSnapshot = await getSandboxOidcStatusSnapshot({
    client,
    computeProviderId: input.computeProviderId,
  });

  await runSandboxOidcOperationWithRetry({
    computeProvider: input.computeProvider,
    computeProviderId: input.computeProviderId,
    operation: 'write sandbox OIDC token files',
    timeoutMs: SANDBOX_OIDC_WRITE_TIMEOUT_MS,
    execute: writeTempFiles,
    onAttemptStart: async ({ attempt, maxAttempts }) => {
      await recordSandboxOidcEventSafe({
        cloudJobId: input.cloudJobId,
        taskId: input.taskId,
        eventType: 'started',
        message: `Starting OIDC token file upload for ${input.computeProvider}:${input.computeProviderId}.`,
        details: {
          ...baseDetails,
          operation: 'write_files',
          timeoutMs: SANDBOX_OIDC_WRITE_TIMEOUT_MS,
          attempt,
          maxAttempts,
          instanceStatusSnapshot: writeStatusSnapshot,
        },
      });
    },
    onAttemptSuccess: async ({ attempt, maxAttempts, durationMs }) => {
      await recordSandboxOidcEventSafe({
        cloudJobId: input.cloudJobId,
        taskId: input.taskId,
        eventType: 'completed',
        message: `Completed OIDC token file upload for ${input.computeProvider}:${input.computeProviderId}.`,
        details: {
          ...baseDetails,
          operation: 'write_files',
          timeoutMs: SANDBOX_OIDC_WRITE_TIMEOUT_MS,
          attempt,
          maxAttempts,
          durationMs,
          instanceStatusSnapshot: writeStatusSnapshot,
        },
      });
    },
    onAttemptFailure: async ({
      attempt,
      maxAttempts,
      durationMs,
      error,
      retryable,
    }) => {
      await recordSandboxOidcEventSafe({
        cloudJobId: input.cloudJobId,
        taskId: input.taskId,
        eventType: 'failed',
        message: `OIDC token file upload failed for ${input.computeProvider}:${input.computeProviderId}.`,
        details: {
          ...baseDetails,
          operation: 'write_files',
          timeoutMs: SANDBOX_OIDC_WRITE_TIMEOUT_MS,
          attempt,
          maxAttempts,
          durationMs,
          retryable,
          instanceStatusSnapshot: writeStatusSnapshot,
          error: extractErrorDetails(error),
        },
      });
    },
  });

  const installStatusSnapshot = await getSandboxOidcStatusSnapshot({
    client,
    computeProviderId: input.computeProviderId,
  });

  const runInstallCommand = async (signal: AbortSignal) => {
    const result = await client.runCommand({
      instanceId: input.computeProviderId,
      cmd: 'sh',
      args: [
        '-lc',
        buildAtomicInstallScript({
          installs: installs.map((install) => ({
            tempPath: install.tempPath,
            targetFile: install.target.tokenFile,
            stagedPath: install.stagedPath,
          })),
          staleFiles,
        }),
      ],
      signal,
    });

    if (result.exitCode !== 0) {
      throw new SandboxOidcCommandExitError({
        computeProvider: input.computeProvider,
        computeProviderId: input.computeProviderId,
        message: result.stderr ?? result.stdout ?? 'unknown error',
        exitCode: result.exitCode ?? -1,
      });
    }

    return result;
  };

  await runSandboxOidcOperationWithRetry({
    computeProvider: input.computeProvider,
    computeProviderId: input.computeProviderId,
    operation: 'install sandbox OIDC token files',
    timeoutMs: SANDBOX_OIDC_COMMAND_TIMEOUT_MS,
    execute: runInstallCommand,
    beforeRetry: async () => {
      await runSandboxOidcOperationWithRetry({
        computeProvider: input.computeProvider,
        computeProviderId: input.computeProviderId,
        operation: 'rewrite sandbox OIDC token files',
        timeoutMs: SANDBOX_OIDC_WRITE_TIMEOUT_MS,
        execute: writeTempFiles,
      });
    },
    onAttemptStart: async ({ attempt, maxAttempts }) => {
      await recordSandboxOidcEventSafe({
        cloudJobId: input.cloudJobId,
        taskId: input.taskId,
        eventType: 'started',
        message: `Starting OIDC token install command for ${input.computeProvider}:${input.computeProviderId}.`,
        details: {
          ...baseDetails,
          operation: 'install_token_files',
          timeoutMs: SANDBOX_OIDC_COMMAND_TIMEOUT_MS,
          attempt,
          maxAttempts,
          instanceStatusSnapshot: installStatusSnapshot,
        },
      });
    },
    onAttemptSuccess: async ({ attempt, maxAttempts, durationMs }) => {
      await recordSandboxOidcEventSafe({
        cloudJobId: input.cloudJobId,
        taskId: input.taskId,
        eventType: 'completed',
        message: `Completed OIDC token install command for ${input.computeProvider}:${input.computeProviderId}.`,
        details: {
          ...baseDetails,
          operation: 'install_token_files',
          timeoutMs: SANDBOX_OIDC_COMMAND_TIMEOUT_MS,
          attempt,
          maxAttempts,
          durationMs,
          instanceStatusSnapshot: installStatusSnapshot,
        },
      });
    },
    onAttemptFailure: async ({
      attempt,
      maxAttempts,
      durationMs,
      error,
      retryable,
    }) => {
      await recordSandboxOidcEventSafe({
        cloudJobId: input.cloudJobId,
        taskId: input.taskId,
        eventType: 'failed',
        message: `OIDC token install command failed for ${input.computeProvider}:${input.computeProviderId}.`,
        details: {
          ...baseDetails,
          operation: 'install_token_files',
          timeoutMs: SANDBOX_OIDC_COMMAND_TIMEOUT_MS,
          attempt,
          maxAttempts,
          durationMs,
          retryable,
          instanceStatusSnapshot: installStatusSnapshot,
          error: extractErrorDetails(error),
        },
      });
    },
  });

  const rows = buildTargetRows({
    now,
    environmentId: input.environmentId,
    computeProvider: input.computeProvider,
    computeProviderId: input.computeProviderId,
    cloudJobId: input.cloudJobId,
    targets,
  });

  if (rows.length > 0) {
    await db
      .insert(sandboxOidcTargets)
      .values(rows)
      .onConflictDoUpdate({
        target: [
          sandboxOidcTargets.computeProvider,
          sandboxOidcTargets.computeProviderId,
          sandboxOidcTargets.tokenFile,
        ],
        set: {
          environmentId: input.environmentId,
          cloudJobId: input.cloudJobId ?? null,
          targetKind: sql`excluded.target_kind`,
          audience: sql`excluded.audience`,
          awsRoleArn: sql`excluded.aws_role_arn`,
          awsRegion: sql`excluded.aws_region`,
          refreshAt: sql`excluded.refresh_at`,
          expiresAt: sql`excluded.expires_at`,
          updatedAt: now,
        },
      });
  }

  if (staleFiles.length > 0) {
    await db
      .delete(sandboxOidcTargets)
      .where(
        and(
          eq(sandboxOidcTargets.computeProvider, input.computeProvider),
          eq(sandboxOidcTargets.computeProviderId, input.computeProviderId),
          inArray(sandboxOidcTargets.tokenFile, staleFiles),
        ),
      );
  }

  return { targetCount: targets.length };
}

export async function cleanupSandboxOidcTargetsForCloudJob(
  cloudJobId: number,
): Promise<void> {
  const rows = await db.query.sandboxOidcTargets.findMany({
    where: eq(sandboxOidcTargets.cloudJobId, cloudJobId),
  });

  const groups = groupRowsByInstance(rows);

  for (const groupedRows of groups.values()) {
    await cleanupSandboxOidcRows(groupedRows);
  }
}

async function refreshSandboxOidcRowsForMachine(
  rows: SandboxOidcTargetRow[],
): Promise<RefreshMachineResult> {
  const firstRow = getFirstRow(rows);

  try {
    const shouldCleanupStoppedInstance =
      await isDeadOrMissingSandboxOidcInstance({
        computeProvider: firstRow.computeProvider,
        computeProviderId: firstRow.computeProviderId,
      });

    if (shouldCleanupStoppedInstance) {
      await cleanupSandboxOidcRows(rows);
      return { status: 'cleaned' };
    }

    const ownerState = await loadOwnerStateForRefresh(firstRow);

    if (!ownerState) {
      await cleanupSandboxOidcRows(rows);
      return { status: 'cleaned' };
    }

    const targets = getEnvironmentOidcTargets(ownerState.environmentConfig);

    if (targets.length === 0) {
      await cleanupSandboxOidcRows(rows);
      return { status: 'cleaned' };
    }

    await primeSandboxOidcTargets({
      taskId: ownerState.taskId,
      environmentId: ownerState.environmentId,
      environmentConfig: ownerState.environmentConfig,
      computeProvider: firstRow.computeProvider,
      computeProviderId: firstRow.computeProviderId,
      cloudJobId: ownerState.cloudJobId,
      now: new Date(),
    });

    return { status: 'refreshed' };
  } catch (error) {
    const shouldCleanupStoppedInstance =
      await isDeadOrMissingSandboxOidcInstance({
        computeProvider: firstRow.computeProvider,
        computeProviderId: firstRow.computeProviderId,
      });

    if (shouldCleanupStoppedInstance) {
      try {
        await cleanupSandboxOidcRows(rows);
        return { status: 'cleaned' };
      } catch (cleanupError) {
        console.error(
          `[sandbox-oidc] Failed to clean OIDC targets for ${firstRow.computeProvider}:${firstRow.computeProviderId} after refresh failure:`,
          cleanupError,
        );
        return { status: 'failed', error: cleanupError };
      }
    }

    console.error(
      `[sandbox-oidc] Failed to refresh OIDC targets for ${firstRow.computeProvider}:${firstRow.computeProviderId}:`,
      error,
    );

    return { status: 'failed', error };
  }
}

export async function refreshDueSandboxOidcTargets(options?: {
  limit?: number;
  now?: Date;
}): Promise<{
  refreshedMachines: number;
  cleanedMachines: number;
  failedMachines: number;
}> {
  const now = options?.now ?? new Date();
  const claimUntil = new Date(
    now.getTime() + SANDBOX_OIDC_REFRESH_CLAIM_DELAY_MS,
  );
  const limit = options?.limit ?? SANDBOX_OIDC_REFRESH_MACHINE_BATCH_SIZE;
  const nowIso = now.toISOString();
  const claimUntilIso = claimUntil.toISOString();

  const claimedRaw = await db.execute(sql`
    WITH due_machines AS (
      SELECT
        compute_provider,
        compute_provider_id,
        COALESCE(cloud_job_id::text, 'none') AS cloud_job_key,
        environment_id,
        MIN(refresh_at) AS next_refresh_at
      FROM sandbox_oidc_targets
      WHERE refresh_at <= ${nowIso}
      GROUP BY
        compute_provider,
        compute_provider_id,
        COALESCE(cloud_job_id::text, 'none'),
        environment_id
      ORDER BY next_refresh_at ASC
      LIMIT ${limit}
    ), due AS (
      SELECT targets.id
      FROM sandbox_oidc_targets AS targets
      INNER JOIN due_machines ON
        targets.compute_provider = due_machines.compute_provider AND
        targets.compute_provider_id = due_machines.compute_provider_id AND
        COALESCE(targets.cloud_job_id::text, 'none') = due_machines.cloud_job_key AND
        targets.environment_id = due_machines.environment_id
      WHERE targets.refresh_at <= ${nowIso}
      FOR UPDATE OF targets SKIP LOCKED
    )
    UPDATE sandbox_oidc_targets AS targets
    SET refresh_at = ${claimUntilIso},
        updated_at = ${nowIso}
    FROM due
    WHERE targets.id = due.id
    RETURNING targets.*;
  `);

  const claimedRows = claimedRaw.map((row) =>
    sandboxOidcTargetRowMapper(row as Record<string, unknown>),
  );

  if (claimedRows.length === 0) {
    return { refreshedMachines: 0, cleanedMachines: 0, failedMachines: 0 };
  }

  const groupedRows = [...groupRowsByInstance(claimedRows).values()];
  const results = await mapWithConcurrency(
    groupedRows,
    SANDBOX_OIDC_REFRESH_CONCURRENCY,
    (rows) => refreshSandboxOidcRowsForMachine(rows),
  );

  const refreshedMachines = results.filter(
    (result) => result.status === 'refreshed',
  ).length;
  const cleanedMachines = results.filter(
    (result) => result.status === 'cleaned',
  ).length;
  const failedMachines = results.filter(
    (result) => result.status === 'failed',
  ).length;

  return { refreshedMachines, cleanedMachines, failedMachines };
}
