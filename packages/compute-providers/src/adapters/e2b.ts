import { E2B_CAPABILITIES as E2B_CAPABILITIES_VALUE } from '@roomote/types';
import { randomUUID } from 'node:crypto';

import {
  CommandExitError,
  NotFoundError,
  Sandbox as E2bSandbox,
  type SandboxInfo as E2bSandboxInfo,
} from 'e2b';
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
  DestroyInstanceInput,
  DestroyInstanceResult,
  E2bConfig,
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

const E2B_SANDBOX_CACHE_TTL_MS = 30 * 60_000;

const E2B_DETACHED_EXIT_GRACE_PERIOD_MS = 1_000;

const E2B_STREAM_POLL_INTERVAL_MS = 1_500;

const DEFAULT_E2B_COMMAND_USER = 'roomote';

const DEFAULT_E2B_COMMAND_HOME = '/home/roomote';

const DEFAULT_E2B_COMMAND_PATH =
  '/home/roomote/.local/bin:/opt/mise/shims:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';

/**
 * E2B forces its own `user` account (uid 1002) as the template default user,
 * and that account cannot traverse the roomote-owned 0700 home where
 * the mise binary lives, so commands and file operations run as root with
 * the worker-image user environment injected — the same root-user tradeoff
 * the Modal adapter documents.
 */
const E2B_EXEC_USER = 'root';

/**
 * Detached commands redirect output to per-command log files so log lookups
 * survive process exit; the persisted command ID encodes the envd process ID
 * and the log file ID so later reads can find both halves again.
 */
const E2B_COMMAND_ID_SEPARATOR = '::';

const E2B_COMMAND_LOG_DIR = '/tmp/roomote-commands';

export class E2bClient implements ComputeProviderClient {
  public readonly vendor: ComputeProvider = 'e2b';

  public readonly capabilities: ComputeProviderCapabilities =
    E2B_CAPABILITIES_VALUE;

  private static readonly sandboxCache = new LRUCache<string, E2bSandbox>({
    max: 100,
    ttl: E2B_SANDBOX_CACHE_TTL_MS,
  });

  private readonly config: E2bConfig;

  public constructor(config: E2bConfig) {
    this.config = { ...config };

    if (!this.config.apiKey) {
      throw new Error('E2B requires an apiKey');
    }

    if (!this.config.templateId) {
      throw new Error(
        'E2B requires an explicit templateId for the baked worker image',
      );
    }

    console.log(
      `[E2bClient] Initializing SDK client ${JSON.stringify({
        apiKeyPrefix: this.config.apiKey.slice(0, 6) + '...',
        domain: this.config.domain ?? '(default)',
        templateId: this.config.templateId,
        timeoutMs: this.config.timeoutMs ?? '(default)',
      })}`,
    );
  }

  private connectionOpts(): { apiKey: string; domain?: string } {
    return {
      apiKey: this.config.apiKey,
      ...(this.config.domain ? { domain: this.config.domain } : {}),
    };
  }

  private async getSandbox(
    sandboxId: string,
    signal?: AbortSignal,
  ): Promise<E2bSandbox> {
    throwIfAborted(signal);

    const cached = E2bClient.sandboxCache.get(sandboxId);

    if (cached) {
      return cached;
    }

    try {
      const sandbox = await raceWithAbort({
        promise: E2bSandbox.connect(sandboxId, this.connectionOpts()),
        signal,
        abortMessage: `Connecting to E2B sandbox ${sandboxId} was aborted`,
      });

      E2bClient.sandboxCache.set(sandboxId, sandbox);

      return sandbox;
    } catch (error) {
      E2bClient.sandboxCache.delete(sandboxId);

      console.error(
        `[E2bClient] Failed to connect to sandbox "${sandboxId}" ${JSON.stringify(
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

    const paginator = E2bSandbox.list({
      ...this.connectionOpts(),
      query: { state: ['running', 'paused'] },
    });

    while (paginator.hasNext) {
      throwIfAborted(input.signal);

      const items = await paginator.nextItems();

      for (const sandbox of items) {
        results.push(summarizeSandbox(sandbox));
      }
    }

    return results;
  }

  public async getInstanceStatus(
    input: GetInstanceStatusInput,
  ): Promise<GetInstanceStatusResult> {
    try {
      const info = await raceWithAbort({
        promise: E2bSandbox.getInfo(input.instanceId, this.connectionOpts()),
        signal: input.signal,
        abortMessage: `Fetching E2B sandbox ${input.instanceId} was aborted`,
      });

      const summary = summarizeSandbox(info);

      return {
        status: summary.status,
        timeoutRemainingMs: summary.timeoutRemainingMs,
      };
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
      `[E2bClient] createInstance starting ${JSON.stringify({
        ports: input.ports,
        tags: input.tags,
        templateId: this.config.templateId,
        timeoutMs: this.config.timeoutMs ?? '(default)',
      })}`,
    );

    const metadata = normalizeMetadata({
      ...(input.metadata ?? {}),
      ...(input.tags ?? {}),
    });

    let sandbox: E2bSandbox;

    try {
      sandbox = await raceWithAbort({
        promise: E2bSandbox.create(this.config.templateId, {
          ...this.connectionOpts(),
          ...(metadata ? { metadata } : {}),
          ...(this.config.timeoutMs
            ? { timeoutMs: this.config.timeoutMs }
            : {}),
        }),
        signal: input.signal,
        abortMessage: 'Creating an E2B sandbox was aborted',
        onLateResolve: async (lateSandbox) => {
          await this.cleanupSandboxAfterFailure(
            lateSandbox,
            'create_instance_late_abort',
          );
        },
      });
    } catch (error) {
      console.error(
        `[E2bClient] Failed to create sandbox ${JSON.stringify({
          error: formatError(error),
        })}`,
      );

      throw error;
    }

    try {
      E2bClient.sandboxCache.set(sandbox.sandboxId, sandbox);

      const domains = resolvePortDomains(sandbox, input.ports);

      console.log(
        `[E2bClient] createInstance complete ${JSON.stringify({
          sandboxId: sandbox.sandboxId,
          domains,
        })}`,
      );

      return { instanceId: sandbox.sandboxId, status: 'running', domains };
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
    try {
      await raceWithAbort({
        promise: E2bSandbox.kill(input.instanceId, this.connectionOpts()),
        signal: input.signal,
        abortMessage: `Destroying E2B sandbox ${input.instanceId} was aborted`,
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

    const command = buildEnvPrefixedCommand(input, execEnv);

    try {
      const result = await sandbox.commands.run(command, {
        user: E2B_EXEC_USER,
        ...(input.cwd ? { cwd: input.cwd } : {}),
        // The provider-side command connection timeout defaults to 60s;
        // callers bound execution through their own AbortSignals instead.
        timeoutMs: 0,
        ...(input.signal ? { signal: input.signal } : {}),
        ...(input.onOutput
          ? {
              onStdout: (data: string) =>
                input.onOutput!({ stream: 'stdout', data }),
              onStderr: (data: string) =>
                input.onOutput!({ stream: 'stderr', data }),
            }
          : {}),
      });

      return {
        commandId: undefined,
        exitCode: result.exitCode,
        stdout: result.stdout || undefined,
        stderr: result.stderr || undefined,
      };
    } catch (error) {
      if (error instanceof CommandExitError) {
        return {
          commandId: undefined,
          exitCode: error.exitCode,
          stdout: error.stdout || undefined,
          stderr: error.stderr || undefined,
        };
      }

      if (isSandboxUnavailableError(error)) {
        this.invalidateSandboxCache(input.instanceId);
      }

      console.error(
        `[E2bClient] runCommand failed ${JSON.stringify({
          instanceId: input.instanceId,
          command,
          error: formatError(error),
        })}`,
      );

      throw error;
    }
  }

  private async runDetachedCommand(
    sandbox: E2bSandbox,
    input: RunCommandInput,
    execEnv: Record<string, string>,
  ): Promise<RunCommandResult> {
    const logId = `roomote-${randomUUID()}`;
    const paths = commandLogPaths(logId);
    const innerCommand = buildEnvPrefixedCommand(input, execEnv);

    const wrappedCommand =
      `mkdir -p ${E2B_COMMAND_LOG_DIR} && ` +
      `{ ${innerCommand}; } > ${paths.stdout} 2> ${paths.stderr}; ` +
      `echo $? > ${paths.exitCode}`;

    const handle = await sandbox.commands.run(wrappedCommand, {
      background: true,
      user: E2B_EXEC_USER,
      ...(input.cwd ? { cwd: input.cwd } : {}),
      timeoutMs: 0,
      ...(input.signal ? { signal: input.signal } : {}),
    });

    const commandId = `${handle.pid}${E2B_COMMAND_ID_SEPARATOR}${logId}`;

    // Stop receiving background command events; the process keeps running
    // and its output lands in the log files either way.
    await handle.disconnect().catch(() => {});

    // Give the detached command a short grace period so immediate startup
    // failures surface as structured results instead of silent exits.
    await sleepWithSignal(E2B_DETACHED_EXIT_GRACE_PERIOD_MS, input.signal);

    const exitCode = await this.readCommandExitCode(sandbox, logId);

    if (exitCode !== null) {
      const stdout = await this.readCommandLogFile(sandbox, paths.stdout);
      const stderr = await this.readCommandLogFile(sandbox, paths.stderr);

      if (input.onOutput) {
        if (stdout) {
          input.onOutput({ stream: 'stdout', data: stdout });
        }

        if (stderr) {
          input.onOutput({ stream: 'stderr', data: stderr });
        }
      }

      console.warn(
        `[E2bClient] Detached command exited during grace period ${JSON.stringify(
          {
            instanceId: input.instanceId,
            commandId,
            exitCode,
            stdoutLen: stdout?.length ?? 0,
            stderrLen: stderr?.length ?? 0,
          },
        )}`,
      );

      return {
        commandId,
        exitCode,
        stdout: stdout || undefined,
        stderr: stderr || undefined,
      };
    }

    return { commandId, exitCode: null };
  }

  public async *streamCommandOutput(
    input: StreamCommandOutputInput,
  ): AsyncIterable<CommandOutputEvent> {
    const { logId } = parseE2bCommandId(input.commandId);
    const sandbox = await this.getSandbox(input.instanceId, input.signal);
    const paths = commandLogPaths(logId);

    let stdoutOffset = 0;
    let stderrOffset = 0;

    while (true) {
      throwIfAborted(input.signal);

      const exited =
        (await this.readCommandExitCode(sandbox, logId, input.signal)) !== null;

      const stdoutDelta = await this.readCommandLogDelta(
        sandbox,
        paths.stdout,
        stdoutOffset,
        input.signal,
      );

      if (stdoutDelta) {
        stdoutOffset += Buffer.byteLength(stdoutDelta);
        yield { stream: 'stdout', data: stdoutDelta };
      }

      const stderrDelta = await this.readCommandLogDelta(
        sandbox,
        paths.stderr,
        stderrOffset,
        input.signal,
      );

      if (stderrDelta) {
        stderrOffset += Buffer.byteLength(stderrDelta);
        yield { stream: 'stderr', data: stderrDelta };
      }

      // The exit marker was written before this round's log reads, so those
      // reads already saw the final output.
      if (exited) {
        return;
      }

      await sleepWithSignal(E2B_STREAM_POLL_INTERVAL_MS, input.signal);
    }
  }

  public async getCommandOutput(input: GetCommandOutputInput): Promise<string> {
    const { logId } = parseE2bCommandId(input.commandId);
    const sandbox = await this.getSandbox(input.instanceId, input.signal);
    const paths = commandLogPaths(logId);

    if (input.stream === 'stdout') {
      return await this.readCommandLogFile(sandbox, paths.stdout, input.signal);
    }

    if (input.stream === 'stderr') {
      return await this.readCommandLogFile(sandbox, paths.stderr, input.signal);
    }

    const [stdout, stderr] = await Promise.all([
      this.readCommandLogFile(sandbox, paths.stdout, input.signal),
      this.readCommandLogFile(sandbox, paths.stderr, input.signal),
    ]);

    return [stdout, stderr].filter(Boolean).join('');
  }

  public async writeFiles(input: WriteFileInput): Promise<void> {
    throwIfAborted(input.signal);

    console.log(
      `[E2bClient] writeFiles ${JSON.stringify({
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

    for (const file of input.files) {
      throwIfAborted(input.signal);

      await raceWithAbort({
        promise: sandbox.files.write(
          file.path,
          new Blob([new Uint8Array(file.content)]),
          { user: E2B_EXEC_USER },
        ),
        signal: input.signal,
        abortMessage: `Uploading ${file.path} to ${input.instanceId} was aborted`,
      });
    }
  }

  public async getInstanceDomains(
    input: GetInstanceDomainsInput,
  ): Promise<GetInstanceDomainsResult> {
    const sandbox = await this.getSandbox(input.instanceId, input.signal);

    return { domains: resolvePortDomains(sandbox, input.ports) ?? {} };
  }

  public async createSnapshot(
    input: CreateSnapshotInput,
  ): Promise<CreateSnapshotResult> {
    throwIfAborted(input.signal);

    console.log(`[E2bClient] Creating snapshot for ${input.instanceId}`);

    // E2B pauses the sandbox while the snapshot template is being built and
    // leaves it paused afterward (unlike Vercel, which stops it). We kill the
    // sandbox explicitly after snapshotting to match the shared
    // snapshot-destroys-sandbox contract.
    let snapshot;

    try {
      snapshot = await raceWithAbort({
        promise: E2bSandbox.createSnapshot(
          input.instanceId,
          this.connectionOpts(),
        ),
        signal: input.signal,
        abortMessage: `Creating snapshot for ${input.instanceId} was aborted`,
        onLateResolve: async (lateSnapshot) => {
          console.warn(
            `[E2bClient] Snapshot completed after local abort for ${input.instanceId}; killing sandbox ${JSON.stringify(
              { snapshotId: lateSnapshot.snapshotId },
            )}`,
          );
          await input.onSnapshotCreated?.(lateSnapshot.snapshotId);
          await this.killSandboxAfterSnapshot(input.instanceId);
        },
      });
    } catch (error) {
      if (isSandboxUnavailableError(error)) {
        this.invalidateSandboxCache(input.instanceId);
      }

      console.error(
        `[E2bClient] Failed to create snapshot ${JSON.stringify({
          instanceId: input.instanceId,
          error: formatError(error),
        })}`,
      );

      throw error;
    }

    console.log(
      `[E2bClient] Snapshot created: ${snapshot.snapshotId}; killing sandbox ${input.instanceId}`,
    );

    // Persist before killing: the id is unrecoverable once the caller's write
    // is skipped, and the sandbox is already gone by then.
    await input.onSnapshotCreated?.(snapshot.snapshotId);

    await this.killSandboxAfterSnapshot(input.instanceId);

    return { snapshotId: snapshot.snapshotId };
  }

  public async resumeFromSnapshot(
    input: ResumeInstanceInput,
  ): Promise<CreatedInstance> {
    throwIfAborted(input.signal);

    console.log(
      `[E2bClient] resumeFromSnapshot starting ${JSON.stringify({
        sourceSnapshotId: input.sourceSnapshotId,
        ports: input.ports,
        tags: input.tags,
      })}`,
    );

    const metadata = normalizeMetadata({
      ...(input.metadata ?? {}),
      ...(input.tags ?? {}),
    });

    let sandbox: E2bSandbox;

    try {
      // E2B snapshots are template builds, so booting from one is a regular
      // sandbox create with the snapshot ID as the template.
      sandbox = await raceWithAbort({
        promise: E2bSandbox.create(input.sourceSnapshotId, {
          ...this.connectionOpts(),
          ...(metadata ? { metadata } : {}),
          ...(this.config.timeoutMs
            ? { timeoutMs: this.config.timeoutMs }
            : {}),
        }),
        signal: input.signal,
        abortMessage: `Resuming an E2B sandbox from snapshot ${input.sourceSnapshotId} was aborted`,
        onLateResolve: async (lateSandbox) => {
          await this.cleanupSandboxAfterFailure(
            lateSandbox,
            'resume_from_snapshot_late_abort',
          );
        },
      });
    } catch (error) {
      console.error(
        `[E2bClient] Failed to resume sandbox from snapshot ${JSON.stringify({
          sourceSnapshotId: input.sourceSnapshotId,
          error: formatError(error),
        })}`,
      );

      throw error;
    }

    try {
      E2bClient.sandboxCache.set(sandbox.sandboxId, sandbox);

      const domains = resolvePortDomains(sandbox, input.ports);

      console.log(
        `[E2bClient] resumeFromSnapshot complete ${JSON.stringify({
          sandboxId: sandbox.sandboxId,
          sourceSnapshotId: input.sourceSnapshotId,
          domains,
        })}`,
      );

      return {
        instanceId: sandbox.sandboxId,
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

  private async killSandboxAfterSnapshot(instanceId: string): Promise<void> {
    try {
      await E2bSandbox.kill(instanceId, this.connectionOpts());
    } catch (error) {
      // The snapshot itself succeeded; a leaked paused sandbox is recoverable
      // via sleep-check, so log instead of failing the snapshot.
      console.error(
        `[E2bClient] Failed to kill sandbox after snapshot ${JSON.stringify({
          instanceId,
          error: formatError(error),
        })}`,
      );
    } finally {
      this.invalidateSandboxCache(instanceId);
    }
  }

  private async readCommandExitCode(
    sandbox: E2bSandbox,
    logId: string,
    signal?: AbortSignal,
  ): Promise<number | null> {
    const content = await this.readCommandLogFile(
      sandbox,
      commandLogPaths(logId).exitCode,
      signal,
    );

    const trimmed = content.trim();

    if (!trimmed) {
      return null;
    }

    const exitCode = Number.parseInt(trimmed, 10);

    return Number.isNaN(exitCode) ? null : exitCode;
  }

  private async readCommandLogFile(
    sandbox: E2bSandbox,
    path: string,
    signal?: AbortSignal,
  ): Promise<string> {
    try {
      return await raceWithAbort({
        promise: sandbox.files.read(path, { user: E2B_EXEC_USER }),
        signal,
        abortMessage: `Reading ${path} was aborted`,
      });
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw error;
      }

      if (isSandboxUnavailableError(error) || error instanceof NotFoundError) {
        return '';
      }

      throw error;
    }
  }

  private async readCommandLogDelta(
    sandbox: E2bSandbox,
    path: string,
    offset: number,
    signal?: AbortSignal,
  ): Promise<string> {
    // tail -c is 1-indexed; reading past EOF or a missing file yields ''.
    const command = `tail -c +${offset + 1} ${shellQuote(path)} 2>/dev/null || true`;

    try {
      const result = await raceWithAbort({
        promise: sandbox.commands.run(command, {
          user: E2B_EXEC_USER,
          timeoutMs: 0,
          ...(signal ? { signal } : {}),
        }),
        signal,
        abortMessage: `Reading command log delta from ${path} was aborted`,
      });

      return result.stdout ?? '';
    } catch (error) {
      if (error instanceof CommandExitError) {
        return '';
      }

      throw error;
    }
  }

  private invalidateSandboxCache(instanceId: string): void {
    E2bClient.sandboxCache.delete(instanceId);
  }

  private async cleanupSandboxAfterFailure(
    sandbox: E2bSandbox,
    phase: string,
  ): Promise<void> {
    try {
      await sandbox.kill();

      console.log(
        `[E2bClient] Cleaned up sandbox after failure ${JSON.stringify({
          sandboxId: sandbox.sandboxId,
          phase,
        })}`,
      );
    } catch (cleanupError) {
      console.error(
        `[E2bClient] Failed to clean up sandbox after failure ${JSON.stringify({
          sandboxId: sandbox.sandboxId,
          phase,
          cleanupError: formatError(cleanupError),
        })}`,
      );
    } finally {
      this.invalidateSandboxCache(sandbox.sandboxId);
    }
  }
}

function summarizeSandbox(info: E2bSandboxInfo): InstanceSummary {
  return {
    instanceId: info.sandboxId,
    status: info.state === 'running' ? 'running' : 'stopped',
    timeoutRemainingMs: Math.max(0, info.endAt.getTime() - Date.now()),
    ...(info.startedAt ? { createdAt: info.startedAt } : {}),
  };
}

function commandLogPaths(logId: string): {
  stdout: string;
  stderr: string;
  exitCode: string;
} {
  return {
    stdout: `${E2B_COMMAND_LOG_DIR}/${logId}.out`,
    stderr: `${E2B_COMMAND_LOG_DIR}/${logId}.err`,
    exitCode: `${E2B_COMMAND_LOG_DIR}/${logId}.exit`,
  };
}

function resolvePortDomains(
  sandbox: E2bSandbox,
  ports?: number[],
): Record<string, string> | undefined {
  if (!ports || ports.length === 0) {
    return undefined;
  }

  const domains: Record<string, string> = {};

  for (const port of ports) {
    domains[port.toString()] = `https://${sandbox.getHost(port)}`;
  }

  return domains;
}

/**
 * E2B runs commands through `bash -l -c`, so login profiles can clobber
 * env-provided PATH values; inlining `env KEY=value ...` into the command
 * makes the worker-image user environment win regardless.
 */
function buildEnvPrefixedCommand(
  input: RunCommandInput,
  execEnv: Record<string, string>,
): string {
  const envPrefix = Object.entries(execEnv).map(
    ([key, value]) => `${key}=${value}`,
  );

  return shellJoin(['env', ...envPrefix, input.cmd, ...(input.args ?? [])]);
}

/**
 * Inject the worker-image user environment so mise, pnpm, and other
 * user-scoped tooling resolve regardless of the exec user E2B picks. The
 * MISE_* values are baked into the worker image as Docker ENV, but envd
 * exec does not propagate image env vars, so they must be re-injected here
 * for the shims to resolve installed tools.
 */
function buildCommandEnv(
  env: Record<string, string> | undefined,
): Record<string, string> {
  return {
    HOME: DEFAULT_E2B_COMMAND_HOME,
    USER: DEFAULT_E2B_COMMAND_USER,
    LOGNAME: DEFAULT_E2B_COMMAND_USER,
    PATH: DEFAULT_E2B_COMMAND_PATH,
    MISE_DATA_DIR: '/opt/mise',
    MISE_CACHE_DIR: '/opt/mise/cache',
    ...(env ?? {}),
  };
}

function parseE2bCommandId(commandId: string): {
  pid: string;
  logId: string;
} {
  const separatorIndex = commandId.indexOf(E2B_COMMAND_ID_SEPARATOR);

  if (separatorIndex === -1) {
    throw new Error(
      `Invalid E2B command ID "${commandId}"; expected "<pid>${E2B_COMMAND_ID_SEPARATOR}<logId>"`,
    );
  }

  return {
    pid: commandId.slice(0, separatorIndex),
    logId: commandId.slice(separatorIndex + E2B_COMMAND_ID_SEPARATOR.length),
  };
}

function normalizeMetadata(
  metadata: Record<string, string>,
): Record<string, string> | undefined {
  const entries = Object.entries(metadata).filter(
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

  if (error instanceof NotFoundError) {
    return true;
  }

  const message = error.message.toLowerCase();

  return (
    message.includes('not found') ||
    message.includes('does not exist') ||
    message.includes('terminated') ||
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
