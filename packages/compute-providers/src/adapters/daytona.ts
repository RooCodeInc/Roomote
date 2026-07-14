import { DAYTONA_CAPABILITIES as DAYTONA_CAPABILITIES_VALUE } from '@roomote/types';
import { randomUUID } from 'node:crypto';

import { Daytona, type Sandbox as DaytonaSandbox } from '@daytonaio/sdk';
import { LRUCache } from 'lru-cache';

import type { ComputeProvider } from '@roomote/types';

import type {
  CommandOutputEvent,
  ComputeProviderCapabilities,
  ComputeProviderClient,
  CreateInstanceInput,
  CreateSnapshotInput,
  CreateSnapshotResult,
  CreatedInstance,
  DaytonaConfig,
  DestroyInstanceInput,
  DestroyInstanceResult,
  GetCommandOutputInput,
  GetInstanceDomainsInput,
  GetInstanceDomainsResult,
  GetInstanceStatusInput,
  GetInstanceStatusResult,
  InstanceSummary,
  ListInstancesInput,
  ResumeInstanceInput,
  RunCommandInput,
  RunCommandResult,
  StreamCommandOutputInput,
  WriteFileInput,
} from '../types';
import { raceWithAbort, sleepWithSignal, throwIfAborted } from '../modal/abort';

const DAYTONA_SANDBOX_CACHE_TTL_MS = 30 * 60_000;

const DAYTONA_DETACHED_EXIT_GRACE_PERIOD_MS = 1_000;

/** Product filesystem snapshots can be slow; mirror Modal's 20-minute budget. */
const DAYTONA_SNAPSHOT_TIMEOUT_SECONDS = 20 * 60;

const DAYTONA_PRODUCT_SNAPSHOT_NAME_PREFIX = 'roomote-run-snap';

const DEFAULT_DAYTONA_COMMAND_USER = 'roomote';

const DEFAULT_DAYTONA_COMMAND_HOME = '/home/roomote';

const DEFAULT_DAYTONA_COMMAND_PATH =
  '/home/roomote/.local/bin:/opt/mise/shims:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';

/**
 * Detached commands run inside a Daytona session; the persisted command ID
 * encodes both halves so log lookups can find the session again.
 */
const DAYTONA_COMMAND_ID_SEPARATOR = '::';

export class DaytonaClient implements ComputeProviderClient {
  public readonly vendor: ComputeProvider = 'daytona';

  public readonly capabilities: ComputeProviderCapabilities =
    DAYTONA_CAPABILITIES_VALUE;

  private static readonly sandboxCache = new LRUCache<string, DaytonaSandbox>({
    max: 100,
    ttl: DAYTONA_SANDBOX_CACHE_TTL_MS,
  });

  private readonly sdk: Daytona;
  private readonly config: DaytonaConfig;

  public constructor(config: DaytonaConfig) {
    this.config = { ...config };

    if (!this.config.apiKey) {
      throw new Error('Daytona requires an apiKey');
    }

    if (!this.config.snapshotName) {
      throw new Error(
        'Daytona requires an explicit snapshotName for the baked worker image',
      );
    }

    console.log(
      `[DaytonaClient] Initializing SDK client ${JSON.stringify({
        apiKeyPrefix: this.config.apiKey.slice(0, 6) + '...',
        apiUrl: this.config.apiUrl ?? '(default)',
        target: this.config.target ?? '(default)',
        snapshotName: this.config.snapshotName,
        timeoutMs: this.config.timeoutMs ?? '(default)',
        memoryGiB: this.config.memoryGiB ?? '(default)',
      })}`,
    );

    this.sdk = new Daytona({
      apiKey: this.config.apiKey,
      ...(this.config.apiUrl ? { apiUrl: this.config.apiUrl } : {}),
      ...(this.config.target ? { target: this.config.target } : {}),
    });
  }

  private async getSandbox(
    sandboxId: string,
    signal?: AbortSignal,
  ): Promise<DaytonaSandbox> {
    throwIfAborted(signal);

    const cached = DaytonaClient.sandboxCache.get(sandboxId);

    if (cached) {
      return cached;
    }

    try {
      const sandbox = await raceWithAbort({
        promise: this.sdk.get(sandboxId),
        signal,
        abortMessage: `Fetching Daytona sandbox ${sandboxId} was aborted`,
      });

      DaytonaClient.sandboxCache.set(sandboxId, sandbox);

      return sandbox;
    } catch (error) {
      DaytonaClient.sandboxCache.delete(sandboxId);

      console.error(
        `[DaytonaClient] Failed to fetch sandbox "${sandboxId}" ${JSON.stringify(
          { error: formatError(error) },
        )}`,
      );

      throw error;
    }
  }

  public async listInstances(
    input: ListInstancesInput,
  ): Promise<InstanceSummary[]> {
    const results: InstanceSummary[] = [];

    for await (const sandbox of this.sdk.list()) {
      throwIfAborted(input.signal);

      results.push({
        instanceId: sandbox.id,
        status: mapSandboxState(sandbox.state),
        timeoutRemainingMs: 0,
        ...(sandbox.createdAt
          ? { createdAt: new Date(sandbox.createdAt) }
          : {}),
      });
    }

    return results;
  }

  public async getInstanceStatus(
    input: GetInstanceStatusInput,
  ): Promise<GetInstanceStatusResult> {
    try {
      // Bypass the cache so state reflects the live sandbox.
      const sandbox = await raceWithAbort({
        promise: this.sdk.get(input.instanceId),
        signal: input.signal,
        abortMessage: `Fetching Daytona sandbox ${input.instanceId} was aborted`,
      });

      DaytonaClient.sandboxCache.set(input.instanceId, sandbox);

      return { status: mapSandboxState(sandbox.state) };
    } catch (error) {
      if (isSandboxUnavailableError(error)) {
        this.invalidateSandboxCache(input.instanceId);
        return { status: 'stopped' };
      }

      throw error;
    }
  }

  public async createInstance(
    input: CreateInstanceInput,
  ): Promise<CreatedInstance> {
    throwIfAborted(input.signal);

    console.log(
      `[DaytonaClient] createInstance starting ${JSON.stringify({
        ports: input.ports,
        tags: input.tags,
        snapshotName: this.config.snapshotName,
        timeoutMs: this.config.timeoutMs ?? '(default)',
      })}`,
    );

    const labels = normalizeLabels({
      ...(input.metadata ?? {}),
      ...(input.tags ?? {}),
    });

    let sandbox: DaytonaSandbox;

    try {
      sandbox = await raceWithAbort({
        promise: this.sdk.create({
          snapshot: this.config.snapshotName,
          public: true,
          ...(this.config.memoryGiB
            ? { resources: { memory: this.config.memoryGiB } }
            : {}),
          ...(labels ? { labels } : {}),
          ...(this.config.timeoutMs
            ? {
                autoStopInterval: Math.ceil(this.config.timeoutMs / 60_000),
              }
            : {}),
        }),
        signal: input.signal,
        abortMessage: 'Creating a Daytona sandbox was aborted',
        onLateResolve: async (lateSandbox) => {
          await this.cleanupSandboxAfterFailure(
            lateSandbox,
            'create_instance_late_abort',
          );
        },
      });
    } catch (error) {
      console.error(
        `[DaytonaClient] Failed to create sandbox ${JSON.stringify({
          error: formatError(error),
        })}`,
      );

      throw error;
    }

    try {
      DaytonaClient.sandboxCache.set(sandbox.id, sandbox);

      const domains = await this.resolvePreviewDomains(
        sandbox,
        input.ports,
        input.signal,
      );

      console.log(
        `[DaytonaClient] createInstance complete ${JSON.stringify({
          sandboxId: sandbox.id,
          domains,
        })}`,
      );

      return { instanceId: sandbox.id, status: 'running', domains };
    } catch (error) {
      await this.cleanupSandboxAfterFailure(
        sandbox,
        'create_instance_post_create',
      );

      throw error;
    }
  }

  public async destroyInstance(
    input: DestroyInstanceInput,
  ): Promise<DestroyInstanceResult> {
    const sandbox = await this.getSandbox(input.instanceId, input.signal);

    try {
      await raceWithAbort({
        promise: sandbox.delete(),
        signal: input.signal,
        abortMessage: `Destroying Daytona sandbox ${input.instanceId} was aborted`,
      });
    } finally {
      this.invalidateSandboxCache(input.instanceId);
    }

    return {};
  }

  public async runCommand(input: RunCommandInput): Promise<RunCommandResult> {
    throwIfAborted(input.signal);

    const sandbox = await this.getSandbox(input.instanceId, input.signal);
    const execEnv = buildCommandEnv(input.env);

    if (input.detached) {
      return await this.runDetachedCommand(sandbox, input, execEnv);
    }

    const command = shellJoin([input.cmd, ...(input.args ?? [])]);

    let response;

    try {
      response = await raceWithAbort({
        promise: sandbox.process.executeCommand(command, input.cwd, execEnv),
        signal: input.signal,
        abortMessage: `Waiting for command "${command}" on ${input.instanceId} was aborted`,
      });
    } catch (error) {
      if (isSandboxUnavailableError(error)) {
        this.invalidateSandboxCache(input.instanceId);
      }

      console.error(
        `[DaytonaClient] executeCommand failed ${JSON.stringify({
          instanceId: input.instanceId,
          command,
          error: formatError(error),
        })}`,
      );

      throw error;
    }

    const stdout = response.result || undefined;

    if (input.onOutput && stdout) {
      input.onOutput({ stream: 'stdout', data: stdout });
    }

    return {
      commandId: undefined,
      exitCode: response.exitCode,
      stdout,
    };
  }

  private async runDetachedCommand(
    sandbox: DaytonaSandbox,
    input: RunCommandInput,
    execEnv: Record<string, string>,
  ): Promise<RunCommandResult> {
    const sessionId = `roomote-${randomUUID()}`;
    const command = buildDetachedCommand(input, execEnv);

    await raceWithAbort({
      promise: sandbox.process.createSession(sessionId),
      signal: input.signal,
      abortMessage: `Creating Daytona session on ${input.instanceId} was aborted`,
    });

    const response = await raceWithAbort({
      promise: sandbox.process.executeSessionCommand(sessionId, {
        command,
        runAsync: true,
      }),
      signal: input.signal,
      abortMessage: `Starting detached command on ${input.instanceId} was aborted`,
    });

    const commandId = `${sessionId}${DAYTONA_COMMAND_ID_SEPARATOR}${response.cmdId}`;

    // Give the detached command a short grace period so immediate startup
    // failures surface as structured results instead of silent exits.
    await sleepWithSignal(DAYTONA_DETACHED_EXIT_GRACE_PERIOD_MS, input.signal);

    const startedCommand = await raceWithAbort({
      promise: sandbox.process.getSessionCommand(sessionId, response.cmdId),
      signal: input.signal,
      abortMessage: `Checking detached command on ${input.instanceId} was aborted`,
    });

    if (
      startedCommand.exitCode !== undefined &&
      startedCommand.exitCode !== null
    ) {
      const logs = await sandbox.process
        .getSessionCommandLogs(sessionId, response.cmdId)
        .catch(() => undefined);

      const stdout = logs?.stdout || logs?.output || undefined;
      const stderr = logs?.stderr || undefined;

      if (input.onOutput) {
        if (stdout) {
          input.onOutput({ stream: 'stdout', data: stdout });
        }

        if (stderr) {
          input.onOutput({ stream: 'stderr', data: stderr });
        }
      }

      console.warn(
        `[DaytonaClient] Detached command exited during grace period ${JSON.stringify(
          {
            instanceId: input.instanceId,
            commandId,
            exitCode: startedCommand.exitCode,
            stdoutLen: stdout?.length ?? 0,
            stderrLen: stderr?.length ?? 0,
          },
        )}`,
      );

      return {
        commandId,
        exitCode: startedCommand.exitCode,
        stdout,
        stderr,
      };
    }

    return { commandId, exitCode: null };
  }

  public async *streamCommandOutput(
    input: StreamCommandOutputInput,
  ): AsyncIterable<CommandOutputEvent> {
    const { sessionId, cmdId } = parseDaytonaCommandId(input.commandId);
    const sandbox = await this.getSandbox(input.instanceId, input.signal);

    const events: CommandOutputEvent[] = [];
    let done = false;
    let failure: unknown;
    let wake: (() => void) | undefined;

    const notify = () => {
      wake?.();
      wake = undefined;
    };

    const streamPromise = sandbox.process
      .getSessionCommandLogs(
        sessionId,
        cmdId,
        (chunk) => {
          events.push({ stream: 'stdout', data: chunk });
          notify();
        },
        (chunk) => {
          events.push({ stream: 'stderr', data: chunk });
          notify();
        },
      )
      .then(() => {
        done = true;
        notify();
      })
      .catch((error) => {
        failure = error;
        done = true;
        notify();
      });

    try {
      while (true) {
        throwIfAborted(input.signal);

        while (events.length > 0) {
          yield events.shift()!;
        }

        if (done) {
          if (failure) {
            throw failure;
          }

          return;
        }

        await new Promise<void>((resolve) => {
          wake = resolve;

          const onAbort = () => {
            input.signal?.removeEventListener('abort', onAbort);
            resolve();
          };

          input.signal?.addEventListener('abort', onAbort, { once: true });
        });
      }
    } finally {
      // Let the underlying log request settle in the background; it has no
      // public cancellation surface.
      streamPromise.catch(() => {});
    }
  }

  public async getCommandOutput(input: GetCommandOutputInput): Promise<string> {
    const { sessionId, cmdId } = parseDaytonaCommandId(input.commandId);
    const sandbox = await this.getSandbox(input.instanceId, input.signal);

    const logs = await raceWithAbort({
      promise: sandbox.process.getSessionCommandLogs(sessionId, cmdId),
      signal: input.signal,
      abortMessage: `Fetching command output on ${input.instanceId} was aborted`,
    });

    if (input.stream === 'stdout') {
      return logs.stdout ?? logs.output ?? '';
    }

    if (input.stream === 'stderr') {
      return logs.stderr ?? '';
    }

    return logs.output ?? [logs.stdout, logs.stderr].filter(Boolean).join('');
  }

  public async writeFiles(input: WriteFileInput): Promise<void> {
    throwIfAborted(input.signal);

    console.log(
      `[DaytonaClient] writeFiles ${JSON.stringify({
        instanceId: input.instanceId,
        files: input.files.map((file) => ({
          path: file.path,
          sizeBytes: file.content.byteLength,
        })),
      })}`,
    );

    const sandbox = await this.getSandbox(input.instanceId, input.signal);

    const dirs = new Set<string>();

    for (const file of input.files) {
      const dir = file.path.replace(/\/[^/]+$/, '');

      if (dir && dir !== '/') {
        dirs.add(dir);
      }
    }

    if (dirs.size > 0) {
      const mkdirResult = await this.runCommand({
        instanceId: input.instanceId,
        cmd: 'mkdir',
        args: ['-p', ...dirs],
        signal: input.signal,
      });

      if (mkdirResult.exitCode !== 0) {
        throw new Error(
          `Failed to create parent directories on ${input.instanceId} (exit code ${mkdirResult.exitCode ?? 'null'}): ${mkdirResult.stderr ?? mkdirResult.stdout ?? 'no output'}`,
        );
      }
    }

    await raceWithAbort({
      promise: sandbox.fs.uploadFiles(
        input.files.map((file) => ({
          source: file.content,
          destination: file.path,
        })),
      ),
      signal: input.signal,
      abortMessage: `Uploading files to ${input.instanceId} was aborted`,
    });
  }

  public async getInstanceDomains(
    input: GetInstanceDomainsInput,
  ): Promise<GetInstanceDomainsResult> {
    const sandbox = await this.getSandbox(input.instanceId, input.signal);

    const domains = await this.resolvePreviewDomains(
      sandbox,
      input.ports,
      input.signal,
    );

    return { domains: domains ?? {} };
  }

  public async createSnapshot(
    input: CreateSnapshotInput,
  ): Promise<CreateSnapshotResult> {
    throwIfAborted(input.signal);

    const snapshotName = deriveDaytonaProductSnapshotName(input.instanceId);

    console.log(
      `[DaytonaClient] Creating snapshot for ${input.instanceId} ${JSON.stringify(
        {
          snapshotName,
          timeoutSeconds: DAYTONA_SNAPSHOT_TIMEOUT_SECONDS,
        },
      )}`,
    );

    const sandbox = await this.getSandbox(input.instanceId, input.signal);

    try {
      await raceWithAbort({
        promise: sandbox._experimental_createSnapshot(
          snapshotName,
          DAYTONA_SNAPSHOT_TIMEOUT_SECONDS,
        ),
        signal: input.signal,
        abortMessage: `Creating snapshot for ${input.instanceId} was aborted`,
        onLateResolve: async () => {
          console.warn(
            `[DaytonaClient] Snapshot completed after local abort for ${input.instanceId}; destroying sandbox ${JSON.stringify(
              { snapshotName },
            )}`,
          );
          await this.destroySandboxAfterSnapshot(input.instanceId);
        },
      });
    } catch (error) {
      if (isSandboxUnavailableError(error)) {
        this.invalidateSandboxCache(input.instanceId);
      }

      console.error(
        `[DaytonaClient] Failed to create snapshot ${JSON.stringify({
          instanceId: input.instanceId,
          snapshotName,
          error: formatError(error),
        })}`,
      );

      throw error;
    }

    console.log(
      `[DaytonaClient] Snapshot created: ${snapshotName}; destroying sandbox ${input.instanceId}`,
    );

    await this.destroySandboxAfterSnapshot(input.instanceId);

    return { snapshotId: snapshotName };
  }

  public async resumeFromSnapshot(
    input: ResumeInstanceInput,
  ): Promise<CreatedInstance> {
    throwIfAborted(input.signal);

    console.log(
      `[DaytonaClient] resumeFromSnapshot starting ${JSON.stringify({
        sourceSnapshotId: input.sourceSnapshotId,
        ports: input.ports,
        tags: input.tags,
      })}`,
    );

    const labels = normalizeLabels({
      ...(input.metadata ?? {}),
      ...(input.tags ?? {}),
    });

    let sandbox: DaytonaSandbox;

    try {
      // Product snapshots are named Daytona snapshots bootable via create(...).
      sandbox = await raceWithAbort({
        promise: this.sdk.create({
          snapshot: input.sourceSnapshotId,
          public: true,
          ...(this.config.memoryGiB
            ? { resources: { memory: this.config.memoryGiB } }
            : {}),
          ...(labels ? { labels } : {}),
          ...(this.config.timeoutMs
            ? {
                autoStopInterval: Math.ceil(this.config.timeoutMs / 60_000),
              }
            : {}),
        }),
        signal: input.signal,
        abortMessage: `Resuming a Daytona sandbox from snapshot ${input.sourceSnapshotId} was aborted`,
        onLateResolve: async (lateSandbox) => {
          await this.cleanupSandboxAfterFailure(
            lateSandbox,
            'resume_from_snapshot_late_abort',
          );
        },
      });
    } catch (error) {
      console.error(
        `[DaytonaClient] Failed to resume sandbox from snapshot ${JSON.stringify(
          {
            sourceSnapshotId: input.sourceSnapshotId,
            error: formatError(error),
          },
        )}`,
      );

      throw error;
    }

    try {
      DaytonaClient.sandboxCache.set(sandbox.id, sandbox);

      const domains = await this.resolvePreviewDomains(
        sandbox,
        input.ports,
        input.signal,
      );

      console.log(
        `[DaytonaClient] resumeFromSnapshot complete ${JSON.stringify({
          sandboxId: sandbox.id,
          sourceSnapshotId: input.sourceSnapshotId,
          domains,
        })}`,
      );

      return {
        instanceId: sandbox.id,
        status: 'running',
        sourceSnapshotId: input.sourceSnapshotId,
        domains,
      };
    } catch (error) {
      await this.cleanupSandboxAfterFailure(
        sandbox,
        'resume_from_snapshot_post_create',
      );

      throw error;
    }
  }

  private async destroySandboxAfterSnapshot(instanceId: string): Promise<void> {
    try {
      const sandbox = await this.getSandbox(instanceId);
      await sandbox.delete();
    } catch (error) {
      // Snapshot itself succeeded; a leftover sandbox can be cleaned up later.
      console.error(
        `[DaytonaClient] Failed to destroy sandbox after snapshot ${JSON.stringify(
          {
            instanceId,
            error: formatError(error),
          },
        )}`,
      );
    } finally {
      this.invalidateSandboxCache(instanceId);
    }
  }

  private async resolvePreviewDomains(
    sandbox: DaytonaSandbox,
    ports?: number[],
    signal?: AbortSignal,
  ): Promise<Record<string, string> | undefined> {
    if (!ports || ports.length === 0) {
      return undefined;
    }

    const domains: Record<string, string> = {};

    for (const port of ports) {
      throwIfAborted(signal);

      try {
        const previewLink = await raceWithAbort({
          promise: sandbox.getPreviewLink(port),
          signal,
          abortMessage: `Resolving preview link for ${sandbox.id}:${port} was aborted`,
        });

        domains[port.toString()] = previewLink.url;
      } catch (error) {
        if (error instanceof Error && error.name === 'AbortError') {
          throw error;
        }

        console.warn(
          `[DaytonaClient] Failed to resolve preview link ${JSON.stringify({
            sandboxId: sandbox.id,
            port,
            error: formatError(error),
          })}`,
        );
      }
    }

    return Object.keys(domains).length > 0 ? domains : undefined;
  }

  private invalidateSandboxCache(instanceId: string): void {
    DaytonaClient.sandboxCache.delete(instanceId);
  }

  private async cleanupSandboxAfterFailure(
    sandbox: DaytonaSandbox,
    phase: string,
  ): Promise<void> {
    try {
      await sandbox.delete();

      console.log(
        `[DaytonaClient] Cleaned up sandbox after failure ${JSON.stringify({
          sandboxId: sandbox.id,
          phase,
        })}`,
      );
    } catch (cleanupError) {
      console.error(
        `[DaytonaClient] Failed to clean up sandbox after failure ${JSON.stringify(
          {
            sandboxId: sandbox.id,
            phase,
            cleanupError: formatError(cleanupError),
          },
        )}`,
      );
    } finally {
      this.invalidateSandboxCache(sandbox.id);
    }
  }
}

function mapSandboxState(state: string | undefined): InstanceSummary['status'] {
  switch (state) {
    case 'creating':
    case 'restoring':
    case 'starting':
    case 'pulling_snapshot':
    case 'pending_build':
    case 'building_snapshot':
    case 'resuming':
      return 'pending';
    case 'started':
      return 'running';
    case 'stopping':
    case 'pausing':
    case 'archiving':
    case 'destroying':
      return 'stopping';
    case 'stopped':
    case 'paused':
    case 'archived':
    case 'destroyed':
      return 'stopped';
    case 'error':
    case 'build_failed':
      return 'failed';
    case 'snapshotting':
      return 'snapshotting';
    default:
      return 'unknown';
  }
}

/**
 * Daytona session commands do not accept env/cwd options, so detached
 * commands inline both into the shell command itself.
 */
function buildDetachedCommand(
  input: RunCommandInput,
  execEnv: Record<string, string>,
): string {
  const envPrefix = Object.entries(execEnv).map(
    ([key, value]) => `${key}=${value}`,
  );

  const command = shellJoin([
    'env',
    ...envPrefix,
    input.cmd,
    ...(input.args ?? []),
  ]);

  return input.cwd ? `cd ${shellQuote(input.cwd)} && ${command}` : command;
}

/**
 * Inject the worker-image user environment so mise, pnpm, and other
 * user-scoped tooling resolve regardless of the exec user Daytona picks.
 */
function buildCommandEnv(
  env: Record<string, string> | undefined,
): Record<string, string> {
  return {
    HOME: DEFAULT_DAYTONA_COMMAND_HOME,
    USER: DEFAULT_DAYTONA_COMMAND_USER,
    LOGNAME: DEFAULT_DAYTONA_COMMAND_USER,
    PATH: DEFAULT_DAYTONA_COMMAND_PATH,
    ...(env ?? {}),
  };
}

function parseDaytonaCommandId(commandId: string): {
  sessionId: string;
  cmdId: string;
} {
  const separatorIndex = commandId.indexOf(DAYTONA_COMMAND_ID_SEPARATOR);

  if (separatorIndex === -1) {
    throw new Error(
      `Invalid Daytona command ID "${commandId}"; expected "<sessionId>${DAYTONA_COMMAND_ID_SEPARATOR}<cmdId>"`,
    );
  }

  return {
    sessionId: commandId.slice(0, separatorIndex),
    cmdId: commandId.slice(
      separatorIndex + DAYTONA_COMMAND_ID_SEPARATOR.length,
    ),
  };
}

/**
 * Product task/env snapshots must never collide with the worker base snapshot
 * (`roomote-worker-*` / DAYTONA_SNAPSHOT_NAME).
 */
export function deriveDaytonaProductSnapshotName(instanceId: string): string {
  const sanitizedInstance = instanceId
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, '-')
    .slice(0, 24);
  const suffix = randomUUID().replace(/-/g, '').slice(0, 12);

  return `${DAYTONA_PRODUCT_SNAPSHOT_NAME_PREFIX}-${sanitizedInstance}-${suffix}`;
}

function normalizeLabels(
  labels: Record<string, string>,
): Record<string, string> | undefined {
  const entries = Object.entries(labels).filter(
    ([key, value]) => key.length > 0 && value.length > 0,
  );

  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

const SHELL_SAFE_PATTERN = /^[A-Za-z0-9_@%+=:,./-]+$/;

function shellQuote(value: string): string {
  if (value.length > 0 && SHELL_SAFE_PATTERN.test(value)) {
    return value;
  }

  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function shellJoin(parts: string[]): string {
  return parts.map(shellQuote).join(' ');
}

function isSandboxUnavailableError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  const message = error.message.toLowerCase();

  return (
    message.includes('not found') ||
    message.includes('does not exist') ||
    message.includes('destroyed') ||
    message.includes('404')
  );
}

function formatError(error: unknown): {
  name?: string;
  message: string;
  stack?: string;
} {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
    };
  }

  return { message: String(error) };
}
