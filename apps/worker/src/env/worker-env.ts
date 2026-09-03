import * as os from 'node:os';

import { configureAuthClientEnv } from '@roomote/auth/client';
import {
  DEFAULT_MODEL_PROVIDER_ENV_KEYS,
  parseModelProviderEnvKeys,
  SANDBOX_OPENROUTER_API_KEY_ENV_VAR_NAME,
} from '@roomote/types';

/**
 * Worker infrastructure secrets. NEVER passed to child processes.
 * Read only by the worker's own Node.js code (SDK calls, service context building).
 */
interface WorkerConfig {
  authToken: string;
  trpcUrl: string;
  roomoteAppUrl: string;
  jobAuthPublicKey?: string;
  previewProxyBaseUrl?: string;
  previewProxySubdomainSuffix?: string;
  previewAuthPublicKey?: string;
  previewAuthCookieName?: string;
  appEnv?: string;
}

const PRESET_SYSTEM_ENV: Record<string, string> = {
  SKIP_ENV_VALIDATION: '1',
  DONT_PROMPT_WSL_INSTALL: '1',
};

const SYSTEM_KEYS = [
  'HOME',
  'PATH',
  'LC_ALL',
  'LANG',
  'PNPM_HOME',
  'NODE_ENV',
  'COREPACK_ENABLE_DOWNLOAD_PROMPT',
  // Container-project tasks use a task-scoped Docker daemon. Keep its endpoint
  // available to setup commands, agent shells, and follow-up processes.
  'DOCKER_HOST',
];

// Capture worker-only config from the launcher, then scrub it from process.env
// so nested application commands do not inherit it accidentally. This includes
// the legacy ROOMOTE_APP_ENV alias the controller still injects for pre-rename
// snapshot workers.
const WORKER_INTERNAL_CONFIG_KEYS = ['R_APP_ENV', 'APP_ENV', 'ROOMOTE_APP_ENV'];
const BLOCKED_USER_FACING_ENV_KEYS = new Set([
  'AUTH_TOKEN',
  'TRPC_URL',
  'R_APP_URL',
  // Legacy alias the controller injects for pre-rename snapshot workers;
  // scrub it from task processes the same as R_APP_URL.
  'ROOMOTE_APP_URL',
  'JOB_AUTH_PRIVATE_KEY',
  'JOB_AUTH_PUBLIC_KEY',
  'PREVIEW_AUTH_PUBLIC_KEY',
  'PREVIEW_AUTH_COOKIE_NAME',
  'PREVIEW_PROXY_BASE_URL',
  'PREVIEW_PROXY_SUBDOMAIN_SUFFIX',
  SANDBOX_OPENROUTER_API_KEY_ENV_VAR_NAME,
]);
const MODEL_RUNTIME_ENV_KEYS = [
  'R_MODEL',
  'R_SMALL_MODEL',
  'R_VISION_MODEL',
  'R_CODE_REVIEW_MODEL',
  'R_EXPLORE_MODEL',
  'R_PLANNING_MODEL',
  'R_MODEL_REASONING_EFFORT',
  'R_SMALL_MODEL_REASONING_EFFORT',
  'R_VISION_MODEL_REASONING_EFFORT',
  'R_CODE_REVIEW_MODEL_REASONING_EFFORT',
  'R_EXPLORE_MODEL_REASONING_EFFORT',
  'R_PLANNING_MODEL_REASONING_EFFORT',
  'R_MODEL_ENV_KEYS',
  'OPENCODE_CONFIG_CONTENT',
  'OPENCODE_COMMAND',
] as const;
function buildLauncherOpenCodeEnv(
  processEnv: NodeJS.ProcessEnv,
): Record<string, string> {
  const env: Record<string, string> = {};

  for (const key of MODEL_RUNTIME_ENV_KEYS) {
    const value = processEnv[key]?.trim();

    if (value) {
      env[key] = value;
    }
  }

  const providerKeys = new Set([
    ...DEFAULT_MODEL_PROVIDER_ENV_KEYS,
    ...parseModelProviderEnvKeys(processEnv.R_MODEL_ENV_KEYS),
  ]);

  for (const key of providerKeys) {
    if (BLOCKED_USER_FACING_ENV_KEYS.has(key)) {
      continue;
    }

    const value = processEnv[key];

    if (value !== undefined) {
      env[key] = value;
    }
  }

  return env;
}

/**
 * Centralized environment manager for the worker.
 *
 * Replaces the pattern of mutating process.env and inheriting it everywhere.
 * Each subprocess context gets an explicitly constructed env object containing
 * only the variables it needs.
 */
export class WorkerEnv {
  /**
   * Minimal OS-level vars every child process needs.
   * Safe to include everywhere - these never conflict with user projects.
   */
  private systemBase: Record<string, string>;

  /**
   * Worker infrastructure secrets. NEVER passed to child processes.
   * Read only by the worker's own Node.js code (SDK calls, service context building).
   */
  private workerConfig: WorkerConfig;

  /**
   * Service connection vars (POSTGRES_URL, REDIS_URL, etc.).
   * Added during workspace preparation. Included in user-facing env.
   */
  private serviceEnv: Record<string, string> = {};

  /**
   * Reloadable runtime env vars derived from org env storage and worker
   * injection helpers (preview hosts, GH_TOKEN, BASH_ENV, etc.).
   */
  private runtimeEnv: Record<string, string> = {};

  /**
   * Launcher-supplied model config and provider keys. These are stable
   * across deployment env reloads because they describe how the harness starts,
   * not the user's project environment.
   */
  private launcherOpenCodeEnv: Record<string, string>;

  /**
   * Stable workspace/user env vars discovered during setup, such as
   * environment-config `env` values. These should survive runtime env reloads.
   */
  private userEnv: Record<string, string> = {};

  constructor({
    systemBase,
    workerConfig,
    launcherOpenCodeEnv = {},
  }: {
    systemBase: Record<string, string>;
    workerConfig: WorkerConfig;
    launcherOpenCodeEnv?: Record<string, string>;
  }) {
    this.systemBase = { ...systemBase, ...PRESET_SYSTEM_ENV };
    this.workerConfig = { ...workerConfig };
    this.launcherOpenCodeEnv = { ...launcherOpenCodeEnv };
  }

  /**
   * Create a WorkerEnv by reading from process.env at startup.
   * After construction, process.env should only retain PATH and LC_ALL.
   */
  static fromProcessEnv(processEnv: NodeJS.ProcessEnv): WorkerEnv {
    const home = processEnv.HOME || os.homedir();
    const miseDataDir = processEnv.MISE_DATA_DIR || `${home}/.local/share/mise`;

    // Build system base: minimal OS-level vars every child process needs.
    const systemBase: Record<string, string> = { ...PRESET_SYSTEM_ENV };

    for (const key of SYSTEM_KEYS) {
      if (processEnv[key]) {
        systemBase[key] = processEnv[key]!;
      }
    }

    // Include all MISE_* vars in system base.
    for (const [key, value] of Object.entries(processEnv)) {
      if (key.startsWith('MISE_') && value) {
        systemBase[key] = value;
      }
    }

    // Ensure mise shims are on PATH (may already be set by setupSystem).
    if (systemBase.PATH && !systemBase.PATH.includes(`${miseDataDir}/shims`)) {
      systemBase.PATH = [
        `${home}/.local/bin`,
        `${miseDataDir}/shims`,
        systemBase.PATH,
      ]
        .filter(Boolean)
        .join(':');
    }

    // Extract worker infrastructure secrets.
    const requiredVars = ['AUTH_TOKEN', 'TRPC_URL', 'R_APP_URL'] as const;

    for (const key of requiredVars) {
      if (!processEnv[key]) {
        throw new Error(`${key} is not set`);
      }
    }

    const workerConfig: WorkerConfig = {
      authToken: processEnv.AUTH_TOKEN!,
      trpcUrl: processEnv.TRPC_URL!,
      jobAuthPublicKey: processEnv.JOB_AUTH_PUBLIC_KEY,
      previewProxyBaseUrl: processEnv.PREVIEW_PROXY_BASE_URL,
      previewProxySubdomainSuffix: processEnv.PREVIEW_PROXY_SUBDOMAIN_SUFFIX,
      previewAuthPublicKey: processEnv.PREVIEW_AUTH_PUBLIC_KEY,
      previewAuthCookieName: processEnv.PREVIEW_AUTH_COOKIE_NAME,
      roomoteAppUrl: processEnv.R_APP_URL!,
      appEnv: processEnv.R_APP_ENV ?? processEnv.APP_ENV,
    };

    const env = new WorkerEnv({
      systemBase,
      workerConfig,
      launcherOpenCodeEnv: buildLauncherOpenCodeEnv(processEnv),
    });

    // Remove preview/auth keys from process.env so they don't leak into child
    // processes. WorkerEnv captures them for direct worker access.
    //
    // This is critical for nested sandboxes: if the outer worker leaves these
    // values in process.env, they override the inner sandbox's own dotenvx
    // values because dotenvx does not replace existing environment variables.
    //
    // NOTE: AUTH_TOKEN is intentionally kept because the SDK client reads it
    // from process.env on each request (packages/sdk/src/client/index.ts).
    const workerSecretKeys = [
      'JOB_AUTH_PRIVATE_KEY',
      'PREVIEW_AUTH_PUBLIC_KEY',
      'PREVIEW_AUTH_COOKIE_NAME',
      'JOB_AUTH_PUBLIC_KEY',
      'PREVIEW_PROXY_BASE_URL',
      'PREVIEW_PROXY_SUBDOMAIN_SUFFIX',
    ];

    for (const key of workerSecretKeys) {
      delete processEnv[key];
    }

    for (const key of WORKER_INTERNAL_CONFIG_KEYS) {
      delete processEnv[key];
    }

    // Important: worker code must not import @roomote/env directly. The only
    // remaining in-process consumer here is @roomote/auth/client, which still
    // needs the captured public keys for sandbox-server token validation after
    // we scrub them from process.env. Configure that client explicitly rather
    // than rehydrating a broad shared env singleton from the worker.
    configureAuthClientEnv({
      nodeEnv: processEnv.NODE_ENV,
      jobAuthPublicKey: env.jobAuthPublicKey,
      previewAuthPublicKey: env.previewAuthPublicKey,
    });

    return env;
  }

  /**
   * Re-read system base from process.env.
   *
   * Called after setupSystem() has modified process.env (PATH, LC_ALL, etc).
   * Worker config values are NOT re-read — they are captured once at
   * construction and remain stable.
   */
  refreshSystemEnv(processEnv: NodeJS.ProcessEnv): void {
    for (const key of SYSTEM_KEYS) {
      if (processEnv[key]) {
        this.systemBase[key] = processEnv[key]!;
      }
    }

    // Re-read MISE_* vars.
    for (const [key, value] of Object.entries(processEnv)) {
      if (key.startsWith('MISE_') && value) {
        this.systemBase[key] = value;
      }
    }
  }

  // --- Context builders ---

  /** For setup commands (ripgrep, agent CLIs, other worker bootstrapping) */
  buildSetupEnv(): Record<string, string> {
    return {
      ...this.systemBase,
    };
  }

  /** For service install/start commands (postgres, redis, etc.) */
  buildServiceInstallEnv(): Record<string, string> {
    return {
      ...this.systemBase,
    };
  }

  /** For user-facing processes (per-repo commands, terminal sessions) */
  buildUserFacingEnv(): Record<string, string> {
    // Note: the deployment's app env (workerConfig.appEnv) is deliberately NOT
    // included here. It describes the Roomote deployment's own deploy context
    // (keepalive defaults, monitoring), not the user project's environment.
    // Exporting it into task processes broke sandboxed dev servers: the
    // unconditional `export R_APP_ENV=production` written into
    // ~/.roomote/env.sh clobbered per-command development overrides, which
    // disabled dev login in Roomote-on-Roomote sandboxes.
    return {
      ...this.systemBase,
      ...this.serviceEnv,
      ...this.runtimeEnv,
      ...this.userEnv,
    };
  }

  buildOpenCodeHarnessEnv(): Record<string, string> {
    return { ...this.launcherOpenCodeEnv };
  }

  // --- Mutators (called during workspace preparation) ---

  addServiceEnv(vars: Record<string, string>): void {
    Object.assign(this.serviceEnv, vars);
  }

  addUserEnv(vars: Record<string, string | undefined>): void {
    for (const [key, value] of Object.entries(vars)) {
      if (value !== undefined) {
        this.userEnv[key] = value;
      }
    }
  }

  setUserEnv(vars: Record<string, string | undefined>): void {
    this.userEnv = {};
    this.addUserEnv(vars);
  }

  setRuntimeEnv(vars: Record<string, string | undefined>): void {
    this.runtimeEnv = {};
    for (const [key, value] of Object.entries(vars)) {
      if (value !== undefined) {
        this.runtimeEnv[key] = value;
      }
    }
  }

  getRuntimeEnv(): Record<string, string> {
    return { ...this.runtimeEnv };
  }

  /** Set a single system base var. */
  setSystemBase(key: string, value: string): void {
    this.systemBase[key] = value;
  }

  // --- Accessors for worker-internal reads ---

  get previewProxyBaseUrl(): string | undefined {
    return this.workerConfig.previewProxyBaseUrl;
  }

  get jobAuthPublicKey(): string | undefined {
    return this.workerConfig.jobAuthPublicKey;
  }

  get previewProxySubdomainSuffix(): string | undefined {
    return this.workerConfig.previewProxySubdomainSuffix;
  }

  get previewAuthPublicKey(): string | undefined {
    return this.workerConfig.previewAuthPublicKey;
  }

  get previewAuthCookieName(): string | undefined {
    return this.workerConfig.previewAuthCookieName;
  }

  get roomoteAppUrl(): string {
    return this.workerConfig.roomoteAppUrl;
  }

  get trpcUrl(): string {
    return this.workerConfig.trpcUrl;
  }

  get authToken(): string {
    return this.workerConfig.authToken;
  }

  get appEnv(): string | undefined {
    return this.workerConfig.appEnv;
  }
}
