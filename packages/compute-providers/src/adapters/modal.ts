import { MODAL_CAPABILITIES as MODAL_CAPABILITIES_VALUE } from '@roomote/types';
import { LRUCache } from 'lru-cache';
import {
  ModalClient as SdkModalClient,
  type Image,
  type Sandbox,
  type App,
  type Secret as ModalSecret,
} from 'modal';

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
  GetCommandOutputInput,
  GetInstanceStatusInput,
  GetInstanceStatusResult,
  InstanceSummary,
  ListInstancesInput,
  ModalConfig,
  ResumeInstanceInput,
  RunCommandInput,
  RunCommandResult,
  StreamCommandOutputInput,
  WriteFileInput,
} from '../types';
import { unsupported } from '../errors';
import {
  raceWithAbort,
  sleepWithSignal,
  toAbortError,
  throwIfAborted,
} from '../modal/abort';
import { normalizeModalRpcError } from '../modal/rpc-diagnostics';

const DEFAULT_APP_NAME = 'roomote';

const DEFAULT_MODAL_WORKDIR = '/sandbox';
const MODAL_VM_DOCKER_COMMAND = [
  '/usr/bin/sudo',
  '/usr/bin/env',
  'DOCKER_INSECURE_NO_IPTABLES_RAW=1',
  '/usr/bin/dockerd',
  '--host=unix:///var/run/docker.sock',
  '--log-level=error',
];

const DEFAULT_MODAL_COMMAND_USER = 'roomote';

const DEFAULT_MODAL_COMMAND_HOME = '/home/roomote';

const DEFAULT_MODAL_COMMAND_PATH =
  '/home/roomote/.local/bin:/opt/mise/shims:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';

export const MODAL_GH_CLI_VERSION = '2.81.0';

const MODAL_SANDBOX_CACHE_TTL_MS = 30 * 60_000;

// Stay comfortably below Modal's 16 MiB ContainerFilesystemExec payload cap.
const MODAL_FILE_WRITE_CHUNK_BYTES = 8 * 1024 * 1024;

const MODAL_DETACHED_EXIT_GRACE_PERIOD_MS = 1_000;
const MODAL_SNAPSHOT_TIMEOUT_MS = 20 * 60_000;

export class ModalClient implements ComputeProviderClient {
  public readonly vendor: ComputeProvider;

  private static readonly sandboxCache = new LRUCache<string, Sandbox>({
    max: 100,
    ttl: MODAL_SANDBOX_CACHE_TTL_MS,
  });

  public readonly capabilities: ComputeProviderCapabilities =
    MODAL_CAPABILITIES_VALUE;

  private readonly sdk: SdkModalClient;
  private readonly config: ModalConfig;
  private readonly appName: string;
  private readonly baseImageRef: string;
  private readonly imageMode: 'ecr-oidc' | 'registry-auth' | 'registry';
  private resolvedAppPromise: Promise<App> | undefined;
  private resolvedEcrSecretPromise: Promise<ModalSecret> | undefined;
  private resolvedRegistrySecretPromise: Promise<ModalSecret> | undefined;

  public constructor(config: ModalConfig) {
    this.config = { ...config };
    this.vendor = config.vendor ?? 'modal';

    const hasAnyEcrConfig = !!(
      this.config.ecrOidcRoleArn || this.config.ecrRegion
    );

    const hasFullEcrConfig = !!(
      this.config.ecrOidcRoleArn && this.config.ecrRegion
    );

    const hasAnyRegistryAuthConfig = !!(
      this.config.registryUsername || this.config.registryPassword
    );

    const hasFullRegistryAuthConfig = !!(
      this.config.registryUsername && this.config.registryPassword
    );

    if (hasAnyEcrConfig && !hasFullEcrConfig) {
      throw new Error(
        'Modal ECR mode requires both ecrOidcRoleArn and ecrRegion',
      );
    }

    if (hasAnyRegistryAuthConfig && !hasFullRegistryAuthConfig) {
      throw new Error(
        'Modal registry auth requires both registryUsername and registryPassword',
      );
    }

    if (hasFullEcrConfig && hasFullRegistryAuthConfig) {
      throw new Error(
        'Modal registry auth and ECR OIDC auth cannot be configured together',
      );
    }

    if (!this.config.baseImageRef) {
      throw new Error(
        'Modal requires an explicit baseImageRef for the baked worker image',
      );
    }

    console.log(
      `[ModalClient] Initializing SDK client ${JSON.stringify({
        tokenIdPrefix: this.config.tokenId?.slice(0, 6) + '...',
        hasTokenSecret: !!this.config.tokenSecret,
        endpoint: this.config.endpoint ?? '(default)',
        environment: this.config.environment ?? '(default)',
        appName: this.config.appName ?? DEFAULT_APP_NAME,
        baseImageRef: this.config.baseImageRef,
        imageMode: hasFullEcrConfig
          ? 'ecr-oidc'
          : hasFullRegistryAuthConfig
            ? 'registry-auth'
            : 'registry',
        cpu: this.config.cpu ?? '(default)',
        cpuLimit: this.config.cpuLimit ?? '(default)',
        memoryMiB: this.config.memoryMiB ?? '(default)',
        memoryLimitMiB: this.config.memoryLimitMiB ?? '(default)',
      })}`,
    );

    this.sdk = new SdkModalClient({
      tokenId: this.config.tokenId,
      tokenSecret: this.config.tokenSecret,
      ...(this.config.endpoint ? { endpoint: this.config.endpoint } : {}),
      ...(this.config.environment
        ? { environment: this.config.environment }
        : {}),
    });

    this.appName = this.config.appName ?? DEFAULT_APP_NAME;
    this.baseImageRef = this.config.baseImageRef;
    this.imageMode = hasFullEcrConfig
      ? 'ecr-oidc'
      : hasFullRegistryAuthConfig
        ? 'registry-auth'
        : 'registry';
  }

  /**
   * Resolve (or create) the Modal App. Cached for the lifetime of this client.
   */
  private getApp(): Promise<App> {
    if (!this.resolvedAppPromise) {
      this.resolvedAppPromise = (async () => {
        console.log(
          `[ModalClient] Resolving app "${this.appName}" (createIfMissing=true)...`,
        );

        const app = await this.sdk.apps.fromName(this.appName, {
          createIfMissing: true,
        });

        console.log(
          `[ModalClient] App resolved ${JSON.stringify({ appName: this.appName })}`,
        );

        return app;
      })().catch((error) => {
        this.resolvedAppPromise = undefined;
        throw normalizeModalRpcError(error, 'app_resolve');
      });
    }

    return this.resolvedAppPromise;
  }

  private async getSandbox(
    sandboxId: string,
    signal?: AbortSignal,
  ): Promise<Sandbox> {
    throwIfAborted(signal);

    const cached = ModalClient.sandboxCache.get(sandboxId);

    if (cached) {
      return cached;
    }

    console.log(`[ModalClient] Cache miss, fetching sandbox "${sandboxId}"...`);

    try {
      const sandbox = await raceWithAbort({
        promise: this.sdk.sandboxes.fromId(sandboxId),
        signal,
        abortMessage: `Fetching Modal sandbox ${sandboxId} was aborted`,
      });

      ModalClient.sandboxCache.set(sandboxId, sandbox);

      return sandbox;
    } catch (error) {
      ModalClient.sandboxCache.delete(sandboxId);

      console.error(
        `[ModalClient] Failed to fetch sandbox "${sandboxId}" ${JSON.stringify({
          error: formatError(error),
        })}`,
      );

      throw normalizeModalRpcError(error, 'sandbox_fetch');
    }
  }

  private async getEcrSecret(): Promise<ModalSecret> {
    if (this.imageMode !== 'ecr-oidc') {
      throw new Error(
        'ECR secret requested while Modal client is not in ECR OIDC mode',
      );
    }

    if (!this.resolvedEcrSecretPromise) {
      this.resolvedEcrSecretPromise = Promise.resolve(
        this.sdk.secrets.fromObject({
          AWS_ROLE_ARN: this.config.ecrOidcRoleArn!,
          AWS_REGION: this.config.ecrRegion!,
        }),
      ).catch((error) => {
        this.resolvedEcrSecretPromise = undefined;
        throw normalizeModalRpcError(error, 'secret_resolve');
      });
    }

    return this.resolvedEcrSecretPromise;
  }

  private async getRegistrySecret(): Promise<ModalSecret> {
    if (this.imageMode !== 'registry-auth') {
      throw new Error(
        'Registry secret requested while Modal client is not in registry auth mode',
      );
    }

    if (!this.resolvedRegistrySecretPromise) {
      this.resolvedRegistrySecretPromise = Promise.resolve(
        this.sdk.secrets.fromObject({
          REGISTRY_USERNAME: this.config.registryUsername!,
          REGISTRY_PASSWORD: this.config.registryPassword!,
        }),
      ).catch((error) => {
        this.resolvedRegistrySecretPromise = undefined;
        throw normalizeModalRpcError(error, 'secret_resolve');
      });
    }

    return this.resolvedRegistrySecretPromise;
  }

  private async resolveImage(): Promise<Image> {
    if (this.imageMode === 'ecr-oidc') {
      const secret = await this.getEcrSecret();
      return this.sdk.images.fromAwsEcr(this.baseImageRef, secret);
    }

    if (this.imageMode === 'registry-auth') {
      const secret = await this.getRegistrySecret();
      return this.sdk.images.fromRegistry(this.baseImageRef, secret);
    }

    return this.sdk.images.fromRegistry(this.baseImageRef);
  }

  private normalizeSandboxTags(
    tags?: Record<string, string>,
  ): Record<string, string> | undefined {
    if (!tags) {
      return undefined;
    }

    const entries = Object.entries(tags).filter(
      ([key, value]) => key.length > 0 && value.length > 0,
    );

    if (entries.length === 0) {
      return undefined;
    }

    return Object.fromEntries(entries);
  }

  private async applySandboxTags(
    sandbox: Sandbox,
    tags?: Record<string, string>,
  ): Promise<void> {
    const normalizedTags = this.normalizeSandboxTags(tags);

    if (!normalizedTags) {
      return;
    }

    console.log(
      `[ModalClient] Setting sandbox tags ${JSON.stringify({
        sandboxId: sandbox.sandboxId,
        tags: normalizedTags,
      })}`,
    );

    try {
      await sandbox.setTags(normalizedTags);
    } catch (error) {
      console.warn(
        `[ModalClient] Failed to set sandbox tags ${JSON.stringify({
          sandboxId: sandbox.sandboxId,
          tags: normalizedTags,
          error: formatError(error),
        })}`,
      );
    }
  }

  public async listInstances(
    input: ListInstancesInput,
  ): Promise<InstanceSummary[]> {
    const results: InstanceSummary[] = [];

    for await (const sandbox of this.sdk.sandboxes.list()) {
      throwIfAborted(input.signal);

      const exitCode = await raceWithAbort({
        promise: sandbox.poll(),
        signal: input.signal,
        abortMessage: 'Listing Modal sandboxes was aborted',
      });

      results.push({
        instanceId: sandbox.sandboxId,
        status: exitCode === null ? 'running' : 'stopped',
        timeoutRemainingMs: 0,
      });
    }

    return results;
  }

  public async getInstanceStatus(
    input: GetInstanceStatusInput,
  ): Promise<GetInstanceStatusResult> {
    try {
      const sandbox = await this.getSandbox(input.instanceId, input.signal);

      return await this.pollSandboxStatus(
        sandbox,
        input.instanceId,
        input.signal,
      );
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
      `[ModalClient] createInstance starting ${JSON.stringify({
        ports: input.ports,
        tags: input.tags,
        appName: this.appName,
        baseImageRef: this.baseImageRef,
        timeoutMs: this.config.timeoutMs ?? '(default)',
      })}`,
    );

    let app;

    try {
      app = await raceWithAbort({
        promise: this.getApp(),
        signal: input.signal,
        abortMessage: `Resolving Modal app "${this.appName}" was aborted`,
      });
    } catch (error) {
      console.error(
        `[ModalClient] Failed to resolve app ${JSON.stringify({
          appName: this.appName,
          error: formatError(error),
        })}`,
      );

      throw error;
    }

    const image = await raceWithAbort({
      promise: this.resolveImage(),
      signal: input.signal,
      abortMessage: `Resolving Modal image "${this.baseImageRef}" was aborted`,
    });

    let sandbox: Sandbox;

    try {
      console.log(
        `[ModalClient] Creating sandbox... ${JSON.stringify({
          encryptedPorts: input.ports,
          regions: this.config.regions ?? '(default)',
          cpu: this.config.cpu ?? '(default)',
          cpuLimit: this.config.cpuLimit ?? '(default)',
          memoryMiB: this.config.memoryMiB ?? '(default)',
          memoryLimitMiB: this.config.memoryLimitMiB ?? '(default)',
        })}`,
      );

      sandbox = await raceWithAbort({
        promise: this.sdk.sandboxes.create(app, image, {
          encryptedPorts: input.ports,
          workdir: DEFAULT_MODAL_WORKDIR,
          ...(this.config.timeoutMs
            ? { timeoutMs: this.config.timeoutMs }
            : {}),
          ...(this.config.cpu ? { cpu: this.config.cpu } : {}),
          ...(this.config.cpuLimit ? { cpuLimit: this.config.cpuLimit } : {}),
          ...(this.config.memoryMiB
            ? { memoryMiB: this.config.memoryMiB }
            : {}),
          ...(this.config.memoryLimitMiB
            ? { memoryLimitMiB: this.config.memoryLimitMiB }
            : {}),
          ...(this.config.regions?.length
            ? { regions: this.config.regions }
            : {}),
          ...(this.config.vmRuntime
            ? {
                command: MODAL_VM_DOCKER_COMMAND,
                experimentalOptions: { vm_runtime: true },
              }
            : {}),
        }),
        signal: input.signal,
        abortMessage: 'Creating a Modal sandbox was aborted',
        onLateResolve: async (lateSandbox) => {
          await this.cleanupSandboxAfterFailure(
            lateSandbox,
            'create_instance_late_abort',
            toAbortError(input.signal, 'Creating a Modal sandbox was aborted'),
          );
        },
      });

      console.log(
        `[ModalClient] Sandbox created ${JSON.stringify({
          sandboxId: sandbox.sandboxId,
        })}`,
      );
    } catch (error) {
      console.error(
        `[ModalClient] Failed to create sandbox ${JSON.stringify({
          error: formatError(error),
        })}`,
      );

      throw normalizeModalRpcError(error, 'create_instance');
    }

    try {
      await this.applySandboxTags(sandbox, input.tags);
      ModalClient.sandboxCache.set(sandbox.sandboxId, sandbox);
      const domains = await this.resolveTunnelDomains(
        sandbox,
        input.ports,
        input.signal,
      );

      console.log(
        `[ModalClient] createInstance complete ${JSON.stringify({
          sandboxId: sandbox.sandboxId,
          domains,
        })}`,
      );

      return { instanceId: sandbox.sandboxId, status: 'running', domains };
    } catch (error) {
      await this.cleanupSandboxAfterFailure(
        sandbox,
        'create_instance_post_create',
        error,
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
        promise: sandbox.terminate(),
        signal: input.signal,
        abortMessage: `Destroying Modal sandbox ${input.instanceId} was aborted`,
      });
    } finally {
      this.invalidateSandboxCache(input.instanceId);
    }

    return {};
  }

  public async runCommand(input: RunCommandInput): Promise<RunCommandResult> {
    throwIfAborted(input.signal);
    const sandbox = await this.getSandbox(input.instanceId, input.signal);
    const { command, execEnv } = this.wrapCommandForDefaultUser(input);
    let process;

    try {
      process = await raceWithAbort({
        promise: sandbox.exec(command, {
          ...(input.cwd ? { workdir: input.cwd } : {}),
          ...(execEnv ? { env: execEnv } : {}),
          stdout: 'pipe',
          stderr: 'pipe',
        }),
        signal: input.signal,
        abortMessage: `Starting command "${command.join(' ')}" on ${input.instanceId} was aborted`,
      });
    } catch (error) {
      if (isSandboxUnavailableError(error)) {
        this.invalidateSandboxCache(input.instanceId);
      }

      console.error(
        `[ModalClient] exec failed ${JSON.stringify({
          instanceId: input.instanceId,
          command,
          error: formatError(error),
        })}`,
      );

      throw normalizeModalRpcError(error, 'command_exec');
    }

    if (input.detached) {
      const waitPromise = process.wait();

      const detachedStartup = await Promise.race([
        waitPromise.then((exitCode) => ({
          status: 'exited' as const,
          exitCode,
        })),
        sleepWithSignal(MODAL_DETACHED_EXIT_GRACE_PERIOD_MS, input.signal).then(
          () => ({ status: 'running' as const }),
        ),
      ]);

      if (detachedStartup.status === 'exited') {
        const [stdoutText, stderrText] = await Promise.all([
          process.stdout.readText(),
          process.stderr.readText(),
        ]);

        const stdout = stdoutText || undefined;
        const stderr = stderrText || undefined;

        if (input.onOutput) {
          if (stdout) {
            input.onOutput({ stream: 'stdout', data: stdout });
          }

          if (stderr) {
            input.onOutput({ stream: 'stderr', data: stderr });
          }
        }

        console.warn(
          `[ModalClient] Detached command exited during grace period ${JSON.stringify(
            {
              instanceId: input.instanceId,
              command,
              exitCode: detachedStartup.exitCode,
              stdoutLen: stdout?.length ?? 0,
              stderrLen: stderr?.length ?? 0,
            },
          )}`,
        );

        return {
          commandId: undefined,
          exitCode: detachedStartup.exitCode,
          stdout,
          stderr,
        };
      }

      // Stream stdout/stderr in the background so we can see what the
      // detached process is doing. This is fire-and-forget.
      streamInBackground(
        `modal:${input.instanceId}`,
        process.stdout,
        process.stderr,
        waitPromise,
        input.onExit,
      );

      return { commandId: undefined, exitCode: null };
    }

    const [stdoutText, stderrText, exitCode] = await raceWithAbort({
      promise: Promise.all([
        process.stdout.readText(),
        process.stderr.readText(),
        process.wait(),
      ]),
      signal: input.signal,
      abortMessage: `Waiting for command "${command.join(' ')}" on ${input.instanceId} was aborted`,
    });

    const stdout = stdoutText || undefined;
    const stderr = stderrText || undefined;

    if (input.onOutput) {
      if (stdout) {
        input.onOutput({ stream: 'stdout', data: stdout });
      }

      if (stderr) {
        input.onOutput({ stream: 'stderr', data: stderr });
      }
    }

    return {
      commandId: undefined,
      exitCode,
      stdout,
      stderr,
    };
  }

  public streamCommandOutput(
    _input: StreamCommandOutputInput,
  ): AsyncIterable<CommandOutputEvent> {
    unsupported(this.vendor, 'streamCommandOutput');
  }

  public getCommandOutput(_input: GetCommandOutputInput): Promise<string> {
    unsupported(this.vendor, 'getCommandOutput');
  }

  public async writeFiles(input: WriteFileInput): Promise<void> {
    throwIfAborted(input.signal);

    console.log(
      `[ModalClient] writeFiles ${JSON.stringify({
        instanceId: input.instanceId,
        files: input.files.map((f) => ({
          path: f.path,
          sizeBytes: f.content.byteLength,
        })),
      })}`,
    );

    const sandbox = await this.getSandbox(input.instanceId, input.signal);

    // Ensure all parent directories exist before writing files.
    const dirs = new Set<string>();

    for (const file of input.files) {
      const dir = file.path.replace(/\/[^/]+$/, '');

      if (dir && dir !== '/') {
        dirs.add(dir);
      }
    }

    if (dirs.size > 0) {
      const mkdirCmd = ['mkdir', '-p', ...dirs];

      console.log(
        `[ModalClient] Creating parent directories ${JSON.stringify({
          dirs: [...dirs],
        })}`,
      );

      try {
        const mkdirProc = await raceWithAbort({
          promise: sandbox.exec(mkdirCmd),
          signal: input.signal,
          abortMessage: `Creating parent directories for ${input.instanceId} was aborted`,
        });

        await raceWithAbort({
          promise: mkdirProc.wait(),
          signal: input.signal,
          abortMessage: `Waiting for directory creation on ${input.instanceId} was aborted`,
        });
      } catch (error) {
        if (isSandboxUnavailableError(error)) {
          this.invalidateSandboxCache(input.instanceId);
        }

        console.error(
          `[ModalClient] Failed to create parent directories ${JSON.stringify({
            dirs: [...dirs],
            error: formatError(error),
          })}`,
        );

        throw normalizeModalRpcError(error, 'write_files_mkdir');
      }
    }

    if (this.config.vmRuntime) {
      for (const file of input.files) {
        try {
          const process = await raceWithAbort({
            promise: sandbox.exec(['/usr/bin/tee', file.path], {
              mode: 'binary',
              stdout: 'ignore',
              stderr: 'pipe',
            }),
            signal: input.signal,
            abortMessage: `Starting streamed write for ${file.path} on ${input.instanceId} was aborted`,
          });
          const stderrPromise = process.stderr.readText().then(
            (value) => ({ value, error: undefined }),
            (error: unknown) => ({ value: '', error }),
          );
          let stdinCloseStarted = false;

          try {
            for (
              let offset = 0;
              offset < file.content.byteLength;
              offset += MODAL_FILE_WRITE_CHUNK_BYTES
            ) {
              throwIfAborted(
                input.signal,
                `Writing ${file.path} on ${input.instanceId} was aborted`,
              );

              const chunkEnd = Math.min(
                offset + MODAL_FILE_WRITE_CHUNK_BYTES,
                file.content.byteLength,
              );
              const chunk = new Uint8Array(
                file.content.buffer,
                file.content.byteOffset + offset,
                chunkEnd - offset,
              );

              await raceWithAbort({
                promise: process.stdin.writeBytes(chunk),
                signal: input.signal,
                abortMessage: `Writing ${file.path} on ${input.instanceId} was aborted`,
              });
            }

            stdinCloseStarted = true;
            await process.stdin.close();

            const [exitCode, stderrResult] = await raceWithAbort({
              promise: Promise.all([process.wait(), stderrPromise]),
              signal: input.signal,
              abortMessage: `Waiting for streamed write of ${file.path} on ${input.instanceId} was aborted`,
            });

            if (stderrResult.error !== undefined) {
              throw stderrResult.error;
            }

            if (exitCode !== 0) {
              throw new Error(
                `Streamed write failed with exit code ${exitCode}${stderrResult.value ? `: ${stderrResult.value}` : ''}`,
              );
            }
          } finally {
            if (!stdinCloseStarted) {
              await process.stdin.close().catch(() => {
                // Best-effort cleanup if the streamed write path aborted.
              });
            }
          }

          console.log(
            `[ModalClient] Wrote VM file ${file.path} (${file.content.byteLength} bytes)`,
          );
        } catch (error) {
          if (isSandboxUnavailableError(error)) {
            this.invalidateSandboxCache(input.instanceId);
          }

          console.error(
            `[ModalClient] Failed to stream VM file ${file.path} ${JSON.stringify(
              {
                error: formatError(error),
              },
            )}`,
          );

          throw normalizeModalRpcError(error, 'write_files_exec');
        }
      }

      return;
    }

    for (const file of input.files) {
      try {
        const handle = await raceWithAbort({
          promise: sandbox.open(file.path, 'w'),
          signal: input.signal,
          abortMessage: `Opening ${file.path} on ${input.instanceId} was aborted`,
        });

        try {
          for (
            let offset = 0;
            offset < file.content.byteLength;
            offset += MODAL_FILE_WRITE_CHUNK_BYTES
          ) {
            throwIfAborted(
              input.signal,
              `Writing ${file.path} on ${input.instanceId} was aborted`,
            );

            const chunkEnd = Math.min(
              offset + MODAL_FILE_WRITE_CHUNK_BYTES,
              file.content.byteLength,
            );

            const chunk = new Uint8Array(
              file.content.buffer,
              file.content.byteOffset + offset,
              chunkEnd - offset,
            );

            await raceWithAbort({
              promise: handle.write(chunk),
              signal: input.signal,
              abortMessage: `Writing ${file.path} on ${input.instanceId} was aborted`,
            });
          }
        } finally {
          await handle.close().catch(() => {
            // Best-effort cleanup if the write path aborted.
          });
        }

        console.log(
          `[ModalClient] Wrote file ${file.path} (${file.content.byteLength} bytes)`,
        );
      } catch (error) {
        if (isSandboxUnavailableError(error)) {
          this.invalidateSandboxCache(input.instanceId);
        }

        console.error(
          `[ModalClient] Failed to write file ${file.path} ${JSON.stringify({
            error: formatError(error),
          })}`,
        );

        throw normalizeModalRpcError(error, 'write_files_open');
      }
    }
  }

  public async createSnapshot(
    input: CreateSnapshotInput,
  ): Promise<CreateSnapshotResult> {
    throwIfAborted(input.signal);

    const sandbox = await this.getSandbox(input.instanceId, input.signal);

    // Modal's snapshotFilesystem() does NOT kill the sandbox (unlike Vercel).
    // We pass a generous timeout since filesystem snapshots can be slow,
    // then explicitly terminate the sandbox afterward to match Vercel's
    // snapshot-kills-sandbox behavior.
    const snapshotTimeoutMs = MODAL_SNAPSHOT_TIMEOUT_MS;

    console.log(
      `[ModalClient] Creating snapshot for ${input.instanceId} (timeout: ${snapshotTimeoutMs}ms)`,
    );

    let image: Awaited<ReturnType<Sandbox['snapshotFilesystem']>>;

    try {
      image = await raceWithAbort({
        promise: sandbox.snapshotFilesystem(snapshotTimeoutMs),
        signal: input.signal,
        abortMessage: `Creating snapshot for ${input.instanceId} was aborted`,
        onLateResolve: async (lateImage) => {
          console.warn(
            `[ModalClient] Snapshot completed after local abort for ${input.instanceId}; terminating sandbox ${JSON.stringify(
              { imageId: lateImage.imageId },
            )}`,
          );
          // The abort already rejected this call, so the id has no other way
          // back to the caller. Persist before terminating so an aborted
          // attempt still leaves a resumable snapshot behind.
          await input.onSnapshotCreated?.(lateImage.imageId);
          await this.terminateSandboxAfterSnapshot(sandbox, input.instanceId);
        },
      });
    } catch (error) {
      if (isSandboxUnavailableError(error)) {
        this.invalidateSandboxCache(input.instanceId);
      }

      throw normalizeModalRpcError(error, 'create_snapshot');
    }

    console.log(
      `[ModalClient] Snapshot created: ${image.imageId}; terminating sandbox ${input.instanceId}`,
    );

    // Persist before terminating, not after returning. Modal images are
    // addressable only by id, so an id lost between here and the caller's
    // write is a snapshot nobody can ever resume.
    await input.onSnapshotCreated?.(image.imageId);

    // Terminate the sandbox after snapshotting to free resources.
    await this.terminateSandboxAfterSnapshot(sandbox, input.instanceId);

    return { snapshotId: image.imageId };
  }

  public async resumeFromSnapshot(
    input: ResumeInstanceInput,
  ): Promise<CreatedInstance> {
    throwIfAborted(input.signal);

    console.log(
      `[ModalClient] resumeFromSnapshot starting ${JSON.stringify({
        sourceSnapshotId: input.sourceSnapshotId,
        ports: input.ports,
        tags: input.tags,
      })}`,
    );

    const app = await raceWithAbort({
      promise: this.getApp(),
      signal: input.signal,
      abortMessage: `Resolving Modal app "${this.appName}" was aborted`,
    });

    let image;

    try {
      console.log(
        `[ModalClient] Loading image from snapshot ID "${input.sourceSnapshotId}"...`,
      );

      image = await raceWithAbort({
        // Must go through the constructed client: the static Image.fromId
        // resolves auth from the default profile/env vars, which are absent
        // when Modal credentials come from the encrypted deployment env vars
        // (fresh spawns worked, snapshot resumes failed with "Profile is
        // missing token_id or token_secret").
        promise: this.sdk.images.fromId(input.sourceSnapshotId),
        signal: input.signal,
        abortMessage: `Loading Modal snapshot ${input.sourceSnapshotId} was aborted`,
      });

      console.log('[ModalClient] Snapshot image loaded');
    } catch (error) {
      console.error(
        `[ModalClient] Failed to load snapshot image ${JSON.stringify({
          sourceSnapshotId: input.sourceSnapshotId,
          error: formatError(error),
        })}`,
      );

      throw normalizeModalRpcError(error, 'snapshot_load');
    }

    let sandbox: Sandbox;

    try {
      console.log(
        `[ModalClient] Creating sandbox from snapshot... ${JSON.stringify({
          encryptedPorts: input.ports,
          regions: this.config.regions ?? '(default)',
        })}`,
      );

      sandbox = await raceWithAbort({
        promise: this.sdk.sandboxes.create(app, image, {
          encryptedPorts: input.ports,
          workdir: DEFAULT_MODAL_WORKDIR,
          ...(this.config.timeoutMs
            ? { timeoutMs: this.config.timeoutMs }
            : {}),
          ...(this.config.cpu ? { cpu: this.config.cpu } : {}),
          ...(this.config.cpuLimit ? { cpuLimit: this.config.cpuLimit } : {}),
          ...(this.config.memoryMiB
            ? { memoryMiB: this.config.memoryMiB }
            : {}),
          ...(this.config.memoryLimitMiB
            ? { memoryLimitMiB: this.config.memoryLimitMiB }
            : {}),
          ...(this.config.regions?.length
            ? { regions: this.config.regions }
            : {}),
          ...(this.config.vmRuntime
            ? {
                command: MODAL_VM_DOCKER_COMMAND,
                experimentalOptions: { vm_runtime: true },
              }
            : {}),
        }),
        signal: input.signal,
        abortMessage: `Resuming Modal snapshot ${input.sourceSnapshotId} was aborted`,
        onLateResolve: async (lateSandbox) => {
          await this.cleanupSandboxAfterFailure(
            lateSandbox,
            'resume_snapshot_late_abort',
            toAbortError(
              input.signal,
              `Resuming Modal snapshot ${input.sourceSnapshotId} was aborted`,
            ),
          );
        },
      });

      console.log(
        `[ModalClient] Sandbox resumed from snapshot ${JSON.stringify({
          sandboxId: sandbox.sandboxId,
        })}`,
      );
    } catch (error) {
      console.error(
        `[ModalClient] Failed to create sandbox from snapshot ${JSON.stringify({
          error: formatError(error),
        })}`,
      );

      throw normalizeModalRpcError(error, 'resume_snapshot');
    }

    try {
      await this.applySandboxTags(sandbox, input.tags);
      ModalClient.sandboxCache.set(sandbox.sandboxId, sandbox);
      const domains = await this.resolveTunnelDomains(
        sandbox,
        input.ports,
        input.signal,
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
        'resume_snapshot_post_create',
        error,
      );

      throw error;
    }
  }

  /**
   * Resolve tunnel URLs for the given ports.
   * Modal exposes ports via tunnels rather than direct domain mapping.
   */
  private async resolveTunnelDomains(
    sandbox: Sandbox,
    ports?: number[],
    signal?: AbortSignal,
  ): Promise<Record<string, string> | undefined> {
    if (!ports || ports.length === 0) {
      return undefined;
    }

    try {
      const tunnels = await raceWithAbort({
        promise: sandbox.tunnels(),
        signal,
        abortMessage: `Resolving tunnel domains for ${sandbox.sandboxId} was aborted`,
      });

      const domains: Record<string, string> = {};

      for (const port of ports) {
        const tunnel = tunnels[port];

        if (tunnel) {
          domains[port.toString()] = tunnel.url;
        }
      }

      return Object.keys(domains).length > 0 ? domains : undefined;
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw error;
      }

      console.warn(
        `[ModalClient] Failed to resolve tunnel domains ${JSON.stringify({
          sandboxId: sandbox.sandboxId,
          ports,
          error: formatError(error),
        })}`,
      );

      return undefined;
    }
  }

  private async pollSandboxStatus(
    sandbox: Sandbox,
    instanceId: string,
    signal?: AbortSignal,
  ): Promise<GetInstanceStatusResult> {
    const exitCode = await raceWithAbort({
      promise: sandbox.poll(),
      signal,
      abortMessage: `Polling Modal sandbox ${instanceId} was aborted`,
    });

    return {
      status: exitCode === null ? 'running' : 'stopped',
    };
  }

  private invalidateSandboxCache(instanceId: string): void {
    ModalClient.sandboxCache.delete(instanceId);
  }

  private async cleanupSandboxAfterFailure(
    sandbox: Sandbox,
    phase: string,
    error: unknown,
  ): Promise<void> {
    console.warn(
      `[ModalClient] Cleaning up sandbox after failure ${JSON.stringify({
        sandboxId: sandbox.sandboxId,
        phase,
        error: formatError(error),
      })}`,
    );

    try {
      await sandbox.terminate();

      console.log(
        `[ModalClient] Cleaned up sandbox after failure ${JSON.stringify({
          sandboxId: sandbox.sandboxId,
          phase,
        })}`,
      );
    } catch (cleanupError) {
      console.error(
        `[ModalClient] Failed to clean up sandbox after failure ${JSON.stringify(
          {
            sandboxId: sandbox.sandboxId,
            phase,
            cleanupError: formatError(cleanupError),
          },
        )}`,
      );
    } finally {
      this.invalidateSandboxCache(sandbox.sandboxId);
    }
  }

  private async terminateSandboxAfterSnapshot(
    sandbox: Sandbox,
    instanceId: string,
  ): Promise<void> {
    try {
      await sandbox.terminate();
    } catch (terminateError) {
      console.warn(
        `[ModalClient] Failed to terminate sandbox ${instanceId} after snapshot: ${
          terminateError instanceof Error
            ? terminateError.message
            : String(terminateError)
        }`,
      );
    } finally {
      this.invalidateSandboxCache(instanceId);
    }
  }

  private wrapCommandForDefaultUser(input: RunCommandInput): {
    command: string[];
    execEnv: Record<string, string> | undefined;
  } {
    const command = [input.cmd, ...(input.args ?? [])];

    // Instead of switching user via `sudo -u roomote` (which triggers
    // the Linux no_new_privs flag and blocks nested sudo inside the worker),
    // run as the default container user (root) but inject the roomote
    // environment so that mise, pnpm, and other user-scoped tooling resolve
    // correctly.
    const execEnv = {
      HOME: DEFAULT_MODAL_COMMAND_HOME,
      USER: DEFAULT_MODAL_COMMAND_USER,
      LOGNAME: DEFAULT_MODAL_COMMAND_USER,
      PATH: DEFAULT_MODAL_COMMAND_PATH,
      ...(input.env ?? {}),
    };

    return {
      command,
      execEnv,
    };
  }
}

/**
 * Stream stdout/stderr from a detached Modal process to the console in the
 * background. This is fire-and-forget — errors are caught and logged.
 */
function streamInBackground(
  label: string,
  stdout: ReadableStream<string>,
  stderr: ReadableStream<string>,
  waitPromise: Promise<number>,
  onExit?: (event: { exitCode: number }) => void | Promise<void>,
): void {
  const pipeStream = async (
    stream: ReadableStream<string>,
    streamName: 'stdout' | 'stderr',
  ) => {
    try {
      const reader = stream.getReader();

      try {
        while (true) {
          const { value, done } = await reader.read();

          if (value) {
            const lines = value.trimEnd().split('\n');

            for (const line of lines) {
              console.log(`[${label}:${streamName}] ${line}`);
            }
          }

          if (done) {
            break;
          }
        }
      } finally {
        reader.releaseLock();
      }
    } catch (error) {
      // Stream may be closed if sandbox is terminated — that's normal.
      const msg = error instanceof Error ? error.message : String(error);

      if (!msg.includes('cancelled') && !msg.includes('terminated')) {
        console.warn(`[${label}] ${streamName} stream error: ${msg}`);
      }
    }
  };

  // Start piping both streams, and log when the process exits.
  Promise.all([
    pipeStream(stdout, 'stdout'),
    pipeStream(stderr, 'stderr'),
    waitPromise
      .then(async (exitCode) => {
        console.log(`[${label}] Detached process exited with code ${exitCode}`);

        await onExit?.({ exitCode });
      })
      .catch((error) => {
        const msg = error instanceof Error ? error.message : String(error);
        console.warn(`[${label}] Detached process exit handler error: ${msg}`);
      }),
  ]).catch(() => {
    // Swallow — individual handlers already log.
  });
}

function isSandboxUnavailableError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  const message = error.message.toLowerCase();

  return (
    message.includes('not found') ||
    message.includes('does not exist') ||
    message.includes('terminated') ||
    message.includes('cancelled')
  );
}

function formatError(error: unknown): {
  name?: string;
  message: string;
  code?: string;
  details?: string;
  stack?: string;
} {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      code: (error as Error & { code?: string }).code,
      details: (error as Error & { details?: string }).details,
      stack: error.stack,
    };
  }

  return { message: String(error) };
}
