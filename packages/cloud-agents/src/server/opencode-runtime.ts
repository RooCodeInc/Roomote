import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  collectOpenRouterVariantModelAlias,
  GOOGLE_APPLICATION_CREDENTIALS_ENV_VAR_NAME,
  isInlineGoogleCredentialsValue,
  mergeOpenCodeModelReasoningOptions,
  mergeOpenRouterVariantAliasModels,
  normalizeOptionalReasoningEffort,
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
  const rawModel = env.ROOMOTE_MODEL?.trim();

  if (!rawModel) {
    return undefined;
  }

  // OpenRouter variant models (`:nitro`, `:free`, ...) are rewritten to their
  // catalog base model and mapped back to the variant through provider model
  // aliases below, because OpenCode rejects model IDs its catalog does not
  // contain.
  const variantAliases = new Map<string, OpenRouterVariantModelAlias>();
  const model = collectOpenRouterVariantModelAlias(variantAliases, rawModel);
  const rawSmallModel = env.ROOMOTE_SMALL_MODEL?.trim();
  const smallModel = rawSmallModel
    ? collectOpenRouterVariantModelAlias(variantAliases, rawSmallModel)
    : undefined;
  const modelReasoningEffort = normalizeOptionalReasoningEffort(
    env.ROOMOTE_MODEL_REASONING_EFFORT?.trim(),
  );
  const smallModelReasoningEffort = normalizeOptionalReasoningEffort(
    env.ROOMOTE_SMALL_MODEL_REASONING_EFFORT?.trim(),
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

  const providerConfig = mergeOpenRouterVariantAliasModels(
    providerReasoningConfig,
    variantAliases,
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
 * When `GOOGLE_APPLICATION_CREDENTIALS` carries inline service-account JSON
 * (the Vertex connect flow stores pasted JSON contents as a deployment env
 * var), write it to a content-addressed temp file and point the env var at
 * that path — Google's auth library only accepts a file path. Path values
 * are left untouched, and failures fall through so Vertex requests surface
 * the library's own credential error.
 */
function materializeInlineGoogleCredentials(env: NodeJS.ProcessEnv): void {
  const credentialsValue = env[GOOGLE_APPLICATION_CREDENTIALS_ENV_VAR_NAME];

  if (!isInlineGoogleCredentialsValue(credentialsValue)) {
    return;
  }

  try {
    const digest = createHash('sha256')
      .update(credentialsValue)
      .digest('hex')
      .slice(0, 16);
    const credentialsDir = path.join(tmpdir(), 'roomote-opencode');
    mkdirSync(credentialsDir, { recursive: true, mode: 0o700 });
    const credentialsFilePath = path.join(
      credentialsDir,
      `google-application-credentials-${digest}.json`,
    );
    writeFileSync(credentialsFilePath, credentialsValue, { mode: 0o600 });
    env[GOOGLE_APPLICATION_CREDENTIALS_ENV_VAR_NAME] = credentialsFilePath;
  } catch (error) {
    console.warn(
      `[OpenCodeRuntime] Failed to materialize inline ${GOOGLE_APPLICATION_CREDENTIALS_ENV_VAR_NAME} JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
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

  if (!env.OPENCODE_CONFIG_CONTENT) {
    const modelBackedConfigContent = buildModelBackedOpenCodeConfigContent(env);

    if (modelBackedConfigContent) {
      env.OPENCODE_CONFIG_CONTENT = modelBackedConfigContent;
    }
  }

  materializeInlineGoogleCredentials(env);

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

function stopChildProcess(proc: ChildProcess): void {
  if (proc.exitCode !== null || proc.signalCode !== null) {
    return;
  }

  proc.kill('SIGTERM');
  setTimeout(() => {
    if (proc.exitCode === null && proc.signalCode === null) {
      proc.kill('SIGKILL');
    }
  }, 2_000).unref();
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
    startTimeoutMs: number;
  }): Promise<OpenCodeSdkServerLease> {
    const configuredUrl = resolveConfiguredOpenCodeSdkServerUrl();

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
      return this.createLease(cached);
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

    return this.createLease(await startPromise);
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

  private closeAll(): void {
    for (const server of this.cache.values()) {
      this.close(server);
    }
    this.startPromises.clear();
  }

  private createLease(server: CachedOpenCodeSdkServer): OpenCodeSdkServerLease {
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
        this.scheduleIdleClose(server);
      },
    };
  }

  private registerShutdown(): void {
    if (this.shutdownRegistered) {
      return;
    }

    this.shutdownRegistered = true;
    process.once('exit', () => this.closeAll());
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
  startTimeoutMs: number;
}): Promise<OpenCodeSdkServerLease> {
  return sharedOpenCodeSdkServerPool.lease(params);
}
