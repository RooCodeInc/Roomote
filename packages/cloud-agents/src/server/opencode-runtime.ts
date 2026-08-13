import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:net';

import {
  collectOpenRouterVariantModelAlias,
  CHATGPT_FAST_MODE_ENV_VAR_NAME,
  DISABLED_MODEL_PROVIDER_ENV_VAR_NAMES,
  isTaskModelIdDisabled,
  mergeAmazonBedrockProviderConfig,
  mergeBedrockMantleOpenAiProviderConfig,
  mergeBedrockMantleProviderConfig,
  mergeOpenAiCompatibleProviderConfig,
  mergeOpenCodeModelReasoningOptions,
  mergeOpenCodeChatGptFastModeOptions,
  mergeOpenRouterVariantAliasModels,
  normalizeOptionalReasoningEffort,
  stripOpenCodeModelReasoningOptions,
  toBedrockMantleRuntimeModelId,
  type OpenRouterVariantModelAlias,
} from '@roomote/types';

const ESCAPE_CHARACTER = String.fromCharCode(27);
const BELL_CHARACTER = String.fromCharCode(7);
const ANSI_CSI_PATTERN = new RegExp(
  `${ESCAPE_CHARACTER}\\[[0-?]*[ -/]*[@-~]`,
  'gu',
);
const ANSI_OSC_PATTERN = new RegExp(
  `${ESCAPE_CHARACTER}\\][^${BELL_CHARACTER}]*(?:${BELL_CHARACTER}|${ESCAPE_CHARACTER}\\\\)`,
  'gu',
);

export const DEFAULT_OPENCODE_SDK_SERVER_START_TIMEOUT_MS = 30_000;
const DEFAULT_OPENCODE_SDK_SERVER_IDLE_TTL_MS = 10 * 60_000;
const OPENCODE_SDK_SERVER_HOSTNAME = '127.0.0.1';
const OPENCODE_SDK_SERVER_READY_POLL_INTERVAL_MS = 100;
const OPENCODE_SDK_SERVER_READY_FETCH_TIMEOUT_MS = 1_000;

function buildModelBackedOpenCodeConfigContent(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const rawModel = env.R_MODEL?.trim();

  if (!rawModel || isTaskModelIdDisabled(rawModel)) {
    return undefined;
  }

  // OpenRouter variant models (`:nitro`, `:free`, ...) are rewritten to their
  // catalog base model and mapped back to the variant through provider model
  // aliases below, because OpenCode rejects model IDs its catalog does not
  // contain. Bedrock Mantle GPT ids are rewritten onto their dedicated
  // OpenAI-compatible provider first, mirroring the task worker — without the
  // rewrite (and the provider registrations below) a Bedrock helper model
  // fails with ProviderModelNotFoundError before any request is made.
  const variantAliases = new Map<string, OpenRouterVariantModelAlias>();
  const model = collectOpenRouterVariantModelAlias(
    variantAliases,
    toBedrockMantleRuntimeModelId(rawModel),
  );
  const rawSmallModel = env.R_SMALL_MODEL?.trim();
  const smallModel =
    rawSmallModel && !isTaskModelIdDisabled(rawSmallModel)
      ? collectOpenRouterVariantModelAlias(
          variantAliases,
          toBedrockMantleRuntimeModelId(rawSmallModel),
        )
      : undefined;
  const rawVisionModel = env.R_VISION_MODEL?.trim();
  const visionModel =
    rawVisionModel && !isTaskModelIdDisabled(rawVisionModel)
      ? collectOpenRouterVariantModelAlias(
          variantAliases,
          toBedrockMantleRuntimeModelId(rawVisionModel),
        )
      : undefined;
  const modelReasoningEffort = normalizeOptionalReasoningEffort(
    env.R_MODEL_REASONING_EFFORT?.trim(),
  );
  const smallModelReasoningEffort = normalizeOptionalReasoningEffort(
    env.R_SMALL_MODEL_REASONING_EFFORT?.trim(),
  );
  const visionModelReasoningEffort = normalizeOptionalReasoningEffort(
    env.R_VISION_MODEL_REASONING_EFFORT?.trim(),
  );

  // Reasoning levels are configured per default-model role, so they are only
  // applied to the exact model each role was configured with. The coding
  // model takes precedence when both roles share a model.
  let providerReasoningConfig: Record<string, unknown> = {};

  if (modelReasoningEffort) {
    providerReasoningConfig = mergeOpenCodeModelReasoningOptions(
      providerReasoningConfig,
      model,
      modelReasoningEffort,
    );
  }

  if (smallModel && smallModelReasoningEffort && smallModel !== model) {
    providerReasoningConfig = mergeOpenCodeModelReasoningOptions(
      providerReasoningConfig,
      smallModel,
      smallModelReasoningEffort,
    );
  }

  if (
    visionModel &&
    visionModelReasoningEffort &&
    visionModel !== model &&
    visionModel !== smallModel
  ) {
    providerReasoningConfig = mergeOpenCodeModelReasoningOptions(
      providerReasoningConfig,
      visionModel,
      visionModelReasoningEffort,
    );
  }

  const providerModelConfig =
    env[CHATGPT_FAST_MODE_ENV_VAR_NAME]?.trim() === '1'
      ? mergeOpenCodeChatGptFastModeOptions(providerReasoningConfig, [
          model,
          smallModel,
          visionModel,
        ])
      : providerReasoningConfig;
  const configuredModelIds = [model, smallModel, visionModel];
  // Same Bedrock provider registrations the task worker applies: OpenCode's
  // catalog knows neither Mantle endpoint, and the native provider does not
  // read the deployment's bearer token on its own.
  const providerConfig = mergeAmazonBedrockProviderConfig(
    mergeBedrockMantleProviderConfig(
      mergeBedrockMantleOpenAiProviderConfig(
        mergeOpenAiCompatibleProviderConfig(
          mergeOpenRouterVariantAliasModels(
            providerModelConfig,
            variantAliases,
          ),
          env,
          configuredModelIds,
          visionModel,
        ),
        env,
        configuredModelIds,
      ),
      env,
      configuredModelIds,
    ),
    env,
    configuredModelIds,
  );

  return JSON.stringify({
    model,
    small_model: smallModel || model,
    ...(Object.keys(providerConfig).length > 0
      ? { provider: providerConfig }
      : {}),
  });
}

/**
 * Per-tool permission denials for the non-task helper servers, covering
 * every tool OpenCode's permission config enumerates.
 *
 * Deliberately the enumerated object form, NOT the blanket `"deny"` string:
 * OpenCode fulfils `format: json_schema` structured output through an
 * internal mechanism that a blanket denial (or a wildcard session rule)
 * strips along with the real tools, which silently breaks every structured
 * routing call while plain-text calls keep working. The object form denies
 * only the listed tools and leaves that mechanism available.
 */
export const NON_TASK_TOOL_PERMISSION_DENIALS = {
  read: 'deny',
  edit: 'deny',
  glob: 'deny',
  grep: 'deny',
  list: 'deny',
  bash: 'deny',
  task: 'deny',
  external_directory: 'deny',
  todowrite: 'deny',
  question: 'deny',
  webfetch: 'deny',
  websearch: 'deny',
  lsp: 'deny',
  skill: 'deny',
} as const;

/**
 * Config keys forwarded to non-task helper servers. Everything else is
 * dropped: OpenCode config can introduce or re-enable tools through several
 * other keys (`mcp` servers, `plugin`, `agent`/`mode` overrides, global
 * `tools` toggles), and any tool from those sources would fall outside
 * {@link NON_TASK_TOOL_PERMISSION_DENIALS}. Allowlisting model/provider
 * selection keeps the server's toolset exactly the built-in one, which the
 * enumerated denials fully cover.
 */
const NON_TASK_CONFIG_ALLOWED_KEYS = [
  'model',
  'small_model',
  'provider',
  'disabled_providers',
  'enabled_providers',
] as const;

/**
 * Reduce a config content string to the model/provider allowlist plus the
 * non-task tool denials.
 *
 * The servers this module spawns exist only for non-task inference — task
 * titles, routing, fast-agent answers — which is plain text or structured
 * output and must never run tools. Without this, OpenCode's default `build`
 * agent auto-approves edit/bash in server mode, and an instruction-shaped
 * prompt (a task description saying "add some dinosaurs") can cause the
 * control plane to edit its own working directory.
 *
 * Operator-supplied `permission` entries never survive, not even for tools
 * outside the enumerated list: unknown entries imply tool sources the
 * allowlist already strips, and allows for built-in tools must not win.
 * Malformed config fails closed to a permission-only config: every non-task
 * call passes its model explicitly, so dropping model-backed defaults keeps
 * text generation working while never booting a server with tools enabled.
 */
function toRestrictedNonTaskConfigContent(
  configContent: string | undefined,
): string {
  const permissionOnly = JSON.stringify({
    permission: NON_TASK_TOOL_PERMISSION_DENIALS,
  });

  if (!configContent?.trim()) {
    return permissionOnly;
  }

  try {
    const parsed: unknown = JSON.parse(configContent);

    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      return permissionOnly;
    }

    const config = parsed as Record<string, unknown>;
    const restricted: Record<string, unknown> = {};

    for (const key of NON_TASK_CONFIG_ALLOWED_KEYS) {
      if (config[key] !== undefined) {
        restricted[key] = config[key];
      }
    }

    // Non-task calls must never run with thinking enabled: structured output
    // (`format: json_schema`) forces tool choice, and Amazon Bedrock rejects
    // thinking combined with forced tool use — a helper-model reasoning
    // effort would fail every routing call on such deployments. Reasoning is
    // a coding-harness setting; title/summary/routing inference never needs
    // it, so strip it for every provider rather than special-casing Bedrock.
    // Applied to the merged config so operator-supplied
    // OPENCODE_CONFIG_CONTENT cannot reintroduce thinking either.
    if (
      restricted.provider &&
      typeof restricted.provider === 'object' &&
      !Array.isArray(restricted.provider)
    ) {
      const strippedProvider = stripOpenCodeModelReasoningOptions(
        restricted.provider as Record<string, unknown>,
      );

      if (Object.keys(strippedProvider).length > 0) {
        restricted.provider = strippedProvider;
      } else {
        delete restricted.provider;
      }
    }

    restricted.permission = NON_TASK_TOOL_PERMISSION_DENIALS;

    return JSON.stringify(restricted);
  } catch {
    return permissionOnly;
  }
}

/**
 * Merges the Bedrock provider registrations for the env's role models into an
 * operator-supplied config content string. Malformed content is returned
 * unchanged — `toRestrictedNonTaskConfigContent` already fails it closed.
 */
function mergeBedrockRegistrationsIntoConfigContent(
  configContent: string,
  env: NodeJS.ProcessEnv,
): string {
  const roleModelIds = (
    [env.R_MODEL, env.R_SMALL_MODEL, env.R_VISION_MODEL] as const
  )
    .map((modelId) => modelId?.trim())
    .filter(
      (modelId): modelId is string =>
        Boolean(modelId) && !isTaskModelIdDisabled(modelId!),
    )
    .map(toBedrockMantleRuntimeModelId);

  if (roleModelIds.length === 0) {
    return configContent;
  }

  try {
    const parsed: unknown = JSON.parse(configContent);

    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      return configContent;
    }

    const config = parsed as Record<string, unknown>;
    const existingProvider =
      config.provider &&
      typeof config.provider === 'object' &&
      !Array.isArray(config.provider)
        ? (config.provider as Record<string, unknown>)
        : {};
    const provider = mergeAmazonBedrockProviderConfig(
      mergeBedrockMantleProviderConfig(
        mergeBedrockMantleOpenAiProviderConfig(
          existingProvider,
          env,
          roleModelIds,
        ),
        env,
        roleModelIds,
      ),
      env,
      roleModelIds,
    );

    if (Object.keys(provider).length === 0) {
      return configContent;
    }

    return JSON.stringify({ ...config, provider });
  } catch {
    return configContent;
  }
}

export function buildOpenCodeCliEnv(
  extraEnv?: Partial<Record<string, string>>,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...extraEnv,
    NO_COLOR: process.env.NO_COLOR ?? '1',
  };

  for (const modelEnvVarName of [
    'R_MODEL',
    'R_SMALL_MODEL',
    'R_VISION_MODEL',
  ] as const) {
    const modelId = env[modelEnvVarName]?.trim();

    if (modelId && isTaskModelIdDisabled(modelId)) {
      delete env[modelEnvVarName];
    }
  }

  if (!env.OPENCODE_CONFIG_CONTENT) {
    const modelBackedConfigContent = buildModelBackedOpenCodeConfigContent(env);

    if (modelBackedConfigContent) {
      env.OPENCODE_CONFIG_CONTENT = modelBackedConfigContent;
    }
  } else {
    // Operator-supplied config skips the model-backed builder, but the role
    // models still need their Bedrock providers registered — otherwise a
    // Bedrock helper model fails with ProviderModelNotFoundError whenever a
    // deployment also sets OPENCODE_CONFIG_CONTENT.
    env.OPENCODE_CONFIG_CONTENT = mergeBedrockRegistrationsIntoConfigContent(
      env.OPENCODE_CONFIG_CONTENT,
      env,
    );
  }

  // Applied unconditionally, after any operator-supplied config content is
  // selected, so custom OPENCODE_CONFIG_CONTENT cannot introduce tools
  // (mcp/plugin/agent config) or re-enable built-in ones.
  env.OPENCODE_CONFIG_CONTENT = toRestrictedNonTaskConfigContent(
    env.OPENCODE_CONFIG_CONTENT,
  );

  // Do not inherit or accept disabled-provider credentials in helper model
  // processes, including callers that bypass the task dequeue path.
  for (const envVarName of DISABLED_MODEL_PROVIDER_ENV_VAR_NAMES) {
    delete env[envVarName];
  }

  // OPENCODE_COMMAND may route through `bash -lc`. An inherited BASH_ENV is
  // sourced after Bash receives this sanitized environment and could restore
  // credentials from a stale shared env file. Helper launches already receive
  // an explicit environment, so they must not source ambient shell state.
  delete env.BASH_ENV;

  return env;
}

function shellEscape(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function resolveOpenCodeCommand(args: string[]): {
  command: string;
  args: string[];
} {
  const configuredCommand = process.env.OPENCODE_COMMAND?.trim();

  if (!configuredCommand) {
    return { command: 'opencode', args };
  }

  if (!/\s/u.test(configuredCommand)) {
    return { command: configuredCommand, args };
  }

  return {
    command: 'bash',
    args: [
      '-lc',
      [configuredCommand, ...args.map((arg) => shellEscape(arg))].join(' '),
    ],
  };
}

function stripTerminalControlSequences(value: string): string {
  return value
    .replace(ANSI_CSI_PATTERN, '')
    .replace(ANSI_OSC_PATTERN, '')
    .replace(/\r\n/gu, '\n')
    .replace(/\r/gu, '\n');
}

export function readOpenCodeDebugConfig(): string {
  const command = resolveOpenCodeCommand(['debug', 'config']);

  return execFileSync(command.command, command.args, {
    encoding: 'utf8',
    env: buildOpenCodeCliEnv(),
    maxBuffer: 1024 * 1024,
    timeout: 30_000,
  });
}

function signalProcessTree(proc: ChildProcess, signal: NodeJS.Signals): void {
  if (proc.exitCode !== null || proc.signalCode !== null || !proc.pid) {
    return;
  }

  // Servers are spawned detached into their own process group, so signaling
  // the negative pid reaches the whole group — including the real opencode
  // process when OPENCODE_COMMAND routes the spawn through a shell wrapper,
  // where `proc` is only the shell.
  try {
    process.kill(-proc.pid, signal);
  } catch {
    try {
      proc.kill(signal);
    } catch {
      // The process exited between the check and the signal.
    }
  }
}

function stopChildProcess(proc: ChildProcess): void {
  signalProcessTree(proc, 'SIGTERM');
  setTimeout(() => {
    signalProcessTree(proc, 'SIGKILL');
  }, 2_000).unref();
}

/**
 * Every spawned OpenCode SDK server process, cached or still starting.
 * Entries remove themselves on exit. Used by the shutdown hooks so no
 * server can outlive the parent process — before this registry existed,
 * dev-watch restarts of the API orphaned the servers to launchd where
 * they leaked 300-650MB each.
 */
const liveOpenCodeSdkServerProcs = new Set<ChildProcess>();

/**
 * Immediately kills every live OpenCode SDK server process group. Uses
 * SIGKILL because this runs while the parent is dying (process 'exit' or a
 * terminating signal): the event loop is about to stop, so the usual
 * SIGTERM-then-SIGKILL escalation timer would never fire, and an ignored
 * SIGTERM would recreate the orphan leak. The servers are stateless
 * localhost inference caches, so a hard kill loses nothing.
 */
export function killOpenCodeSdkServerProcessesForShutdown(): void {
  for (const proc of liveOpenCodeSdkServerProcs) {
    signalProcessTree(proc, 'SIGKILL');
  }
}

type ManagedOpenCodeSdkServer = {
  close: () => void;
  proc: ChildProcess;
  url: string;
};

type CachedOpenCodeSdkServer = ManagedOpenCodeSdkServer & {
  activeLeases: number;
  cacheKey: string;
  idleTimeout: NodeJS.Timeout | null;
};

type OpenCodeSdkServerLease = {
  release: () => void;
  url: string;
};

function getOpenCodeSdkServerIdleTtlMs(): number {
  const configured = Number.parseInt(
    process.env.OPENCODE_SDK_SERVER_IDLE_TTL_MS ?? '',
    10,
  );

  return Number.isFinite(configured) && configured >= 0
    ? configured
    : DEFAULT_OPENCODE_SDK_SERVER_IDLE_TTL_MS;
}

function resolveConfiguredOpenCodeSdkServerUrl(): string | undefined {
  return (
    process.env.OPENCODE_SDK_SERVER_URL?.trim() ||
    process.env.OPENCODE_SERVER_URL?.trim() ||
    undefined
  );
}

function stableStringifyRecord(
  value: Partial<Record<string, string>> | undefined,
): string {
  return JSON.stringify(
    Object.fromEntries(
      Object.entries(value ?? {})
        .filter((entry): entry is [string, string] => Boolean(entry[1]))
        .sort(([left], [right]) => left.localeCompare(right)),
    ),
  );
}

function buildOpenCodeSdkServerCacheKey(
  extraEnv?: Partial<Record<string, string>>,
): string {
  const command = resolveOpenCodeCommand([
    'serve',
    `--hostname=${OPENCODE_SDK_SERVER_HOSTNAME}`,
    '--port=0',
  ]);

  return createHash('sha256')
    .update(
      JSON.stringify({
        command,
        extraEnv: stableStringifyRecord(extraEnv),
        opencodeConfigContent:
          process.env.OPENCODE_CONFIG_CONTENT?.trim() || null,
      }),
    )
    .digest('hex');
}

function formatOpenCodeSdkServerOutput(output: string): string {
  const strippedOutput = stripTerminalControlSequences(output).trim();

  return strippedOutput ? ` Server output: ${strippedOutput}` : '';
}

function reserveTcpPort(hostname: string): Promise<number> {
  const server = createServer();

  return new Promise((resolve, reject) => {
    const cleanup = () => {
      server.off('error', onError);
    };

    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };

    server.once('error', onError);
    server.listen(0, hostname, () => {
      const address = server.address();

      if (!address || typeof address === 'string') {
        cleanup();
        server.close();
        reject(new Error('Could not reserve an OpenCode SDK server port.'));
        return;
      }

      const reservedPort = address.port;

      server.close((error) => {
        cleanup();

        if (error) {
          reject(error);
          return;
        }

        resolve(reservedPort);
      });
    });
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms).unref();
  });
}

async function isOpenCodeSdkServerReady(url: string): Promise<boolean> {
  const abortController = new AbortController();
  const timeout = setTimeout(() => {
    abortController.abort();
  }, OPENCODE_SDK_SERVER_READY_FETCH_TIMEOUT_MS);

  try {
    const response = await fetch(url, { signal: abortController.signal });
    await response.body?.cancel().catch(() => undefined);

    return response.status < 500;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

async function waitForOpenCodeSdkServerReady(
  url: string,
  isSettled: () => boolean,
): Promise<void> {
  while (!isSettled()) {
    if (await isOpenCodeSdkServerReady(url)) {
      return;
    }

    await delay(OPENCODE_SDK_SERVER_READY_POLL_INTERVAL_MS);
  }
}

async function startManagedOpenCodeSdkServer(
  timeoutMs: number,
  extraEnv?: Partial<Record<string, string>>,
): Promise<ManagedOpenCodeSdkServer> {
  const port = await reserveTcpPort(OPENCODE_SDK_SERVER_HOSTNAME);
  const url = `http://${OPENCODE_SDK_SERVER_HOSTNAME}:${port}`;
  const command = resolveOpenCodeCommand([
    'serve',
    `--hostname=${OPENCODE_SDK_SERVER_HOSTNAME}`,
    `--port=${port}`,
  ]);
  const proc = spawn(command.command, command.args, {
    env: buildOpenCodeCliEnv(extraEnv),
    stdio: ['ignore', 'pipe', 'pipe'],
    // Own process group, so shutdown can signal the entire tree (shell
    // wrappers included) via the negative pid.
    detached: true,
  });

  liveOpenCodeSdkServerProcs.add(proc);
  proc.once('exit', () => {
    liveOpenCodeSdkServerProcs.delete(proc);
  });

  let output = '';

  return await new Promise((resolve, reject) => {
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) {
        return;
      }

      settled = true;
      stopChildProcess(proc);
      reject(
        new Error(
          `Timed out waiting for OpenCode SDK server at ${url} after ${timeoutMs}ms.${formatOpenCodeSdkServerOutput(output)}`,
        ),
      );
    }, timeoutMs);

    const finish = (result: ManagedOpenCodeSdkServer): void => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timeout);
      resolve(result);
    };

    const fail = (error: Error): void => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timeout);
      stopChildProcess(proc);
      reject(error);
    };

    const handleOutput = (chunk: Buffer): void => {
      output += chunk.toString();
    };

    proc.stdout?.on('data', handleOutput);
    proc.stderr?.on('data', handleOutput);
    proc.on('error', fail);
    proc.on('exit', (code, signal) => {
      if (settled) {
        return;
      }

      fail(
        new Error(
          `OpenCode SDK server exited before it was ready at ${url} with code ${String(code)} signal ${String(signal)}.${formatOpenCodeSdkServerOutput(output)}`,
        ),
      );
    });

    void waitForOpenCodeSdkServerReady(url, () => settled)
      .then(() => {
        finish({
          url,
          close: () => stopChildProcess(proc),
          proc,
        });
      })
      .catch(fail);
  });
}

class OpenCodeSdkServerPool {
  private readonly cache = new Map<string, CachedOpenCodeSdkServer>();
  private shutdownRegistered = false;
  private readonly startPromises = new Map<
    string,
    Promise<CachedOpenCodeSdkServer>
  >();

  async lease(params: {
    env?: Partial<Record<string, string>>;
    ephemeral?: boolean;
    startTimeoutMs: number;
    useConfiguredServer?: boolean;
  }): Promise<OpenCodeSdkServerLease> {
    const configuredUrl =
      params.useConfiguredServer === false
        ? undefined
        : resolveConfiguredOpenCodeSdkServerUrl();

    if (configuredUrl) {
      return {
        url: configuredUrl,
        release: () => undefined,
      };
    }

    this.registerShutdown();

    const cacheKey = buildOpenCodeSdkServerCacheKey(params.env);
    const cached = this.cache.get(cacheKey);

    if (cached) {
      return this.createLease(cached, params.ephemeral);
    }

    let startPromise = this.startPromises.get(cacheKey);

    if (!startPromise) {
      startPromise = startManagedOpenCodeSdkServer(
        params.startTimeoutMs,
        params.env,
      )
        .then((server) => this.cacheStartedServer(cacheKey, server))
        .finally(() => {
          this.startPromises.delete(cacheKey);
        });
      this.startPromises.set(cacheKey, startPromise);
    }

    return this.createLease(await startPromise, params.ephemeral);
  }

  private cacheStartedServer(
    cacheKey: string,
    server: ManagedOpenCodeSdkServer,
  ): CachedOpenCodeSdkServer {
    const cachedServer: CachedOpenCodeSdkServer = {
      ...server,
      activeLeases: 0,
      cacheKey,
      idleTimeout: null,
    };

    server.proc.on('exit', () => {
      if (cachedServer.idleTimeout) {
        clearTimeout(cachedServer.idleTimeout);
        cachedServer.idleTimeout = null;
      }

      if (this.cache.get(cacheKey) === cachedServer) {
        this.cache.delete(cacheKey);
      }
    });

    this.cache.set(cacheKey, cachedServer);
    return cachedServer;
  }

  private close(server: CachedOpenCodeSdkServer): void {
    if (server.idleTimeout) {
      clearTimeout(server.idleTimeout);
      server.idleTimeout = null;
    }

    if (this.cache.get(server.cacheKey) === server) {
      this.cache.delete(server.cacheKey);
    }

    server.close();
  }

  private createLease(
    server: CachedOpenCodeSdkServer,
    ephemeral = false,
  ): OpenCodeSdkServerLease {
    server.activeLeases += 1;

    if (server.idleTimeout) {
      clearTimeout(server.idleTimeout);
      server.idleTimeout = null;
    }

    let released = false;

    return {
      url: server.url,
      release: () => {
        if (released) {
          return;
        }

        released = true;
        server.activeLeases = Math.max(0, server.activeLeases - 1);

        // One-shot callers (credential validation) hold candidate secrets in
        // the server env and never reuse it, so the process must die with the
        // lease instead of idling out the TTL.
        if (ephemeral && server.activeLeases === 0) {
          this.close(server);
          return;
        }

        this.scheduleIdleClose(server);
      },
    };
  }

  private registerShutdown(): void {
    if (this.shutdownRegistered) {
      return;
    }

    this.shutdownRegistered = true;
    process.once('exit', () => {
      killOpenCodeSdkServerProcessesForShutdown();
    });

    // A terminating signal with no handler kills Node without running
    // 'exit' hooks, which is exactly what dev watchers (`node --watch`,
    // `tsx watch`) and pm2 send on restart — the historical orphan path.
    // Kill the servers first, then re-deliver the signal so the default
    // termination still happens unless another handler owns shutdown.
    for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) {
      process.once(signal, () => {
        killOpenCodeSdkServerProcessesForShutdown();

        if (process.listenerCount(signal) === 0) {
          process.kill(process.pid, signal);
        }
      });
    }
  }

  private scheduleIdleClose(server: CachedOpenCodeSdkServer): void {
    if (server.activeLeases > 0 || server.idleTimeout) {
      return;
    }

    server.idleTimeout = setTimeout(() => {
      this.close(server);
    }, getOpenCodeSdkServerIdleTtlMs());
    server.idleTimeout.unref();
  }
}

const sharedOpenCodeSdkServerPool = new OpenCodeSdkServerPool();

export function leaseOpenCodeSdkServer(params: {
  env?: Partial<Record<string, string>>;
  /**
   * Close the managed server as soon as the last lease is released instead
   * of caching it for the idle TTL. For one-shot calls whose env carries
   * candidate secrets that must not outlive the request.
   */
  ephemeral?: boolean;
  startTimeoutMs: number;
  /**
   * Whether an operator-supplied OpenCode server may serve the request.
   * Credential validation disables this so candidate env values necessarily
   * reach the process that performs the provider request.
   */
  useConfiguredServer?: boolean;
}): Promise<OpenCodeSdkServerLease> {
  return sharedOpenCodeSdkServerPool.lease(params);
}
