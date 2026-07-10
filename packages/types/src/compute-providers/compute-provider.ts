import { SANDBOX_FILES_DIR } from './worker-runtime';

/**
 * ComputeProvider
 *
 * Determines which infrastructure vendor will execute the task run.
 */

export const computeProviders = ['modal', 'docker', 'daytona', 'e2b'] as const;

export type ComputeProvider = (typeof computeProviders)[number];

/**
 * Providers whose runtimes can be snapshotted and later resumed by the
 * scheduled sleep-check pipeline.
 */
export const snapshotCapableComputeProviders = [
  'modal',
  'e2b',
] as const satisfies readonly ComputeProvider[];

/**
 * Providers whose machine lifecycle is managed by the scheduled sleep-check
 * pipeline. Snapshot-capable providers get snapshot-or-destroy handling;
 * other managed providers (Daytona) are always destroyed on sleep.
 */
export const sleepCheckManagedComputeProviders = [
  ...snapshotCapableComputeProviders,
  'daytona',
] as const satisfies readonly ComputeProvider[];

export const isComputeProvider = (
  provider: string,
): provider is ComputeProvider =>
  computeProviders.includes(provider as ComputeProvider);

export const isSleepCheckManagedComputeProvider = (
  provider: string | null | undefined,
): provider is ComputeProvider =>
  sleepCheckManagedComputeProviders.includes(
    provider as (typeof sleepCheckManagedComputeProviders)[number],
  );

export const isSnapshotCapableComputeProvider = (
  provider: string | null | undefined,
): provider is ComputeProvider =>
  snapshotCapableComputeProviders.includes(
    provider as (typeof snapshotCapableComputeProviders)[number],
  );

/**
 * Worker runtime labels. `sandbox` denotes the shared hosted-sandbox
 * filesystem layout (the `/sandbox` root) regardless of provider; it
 * predates the multi-provider split and is what
 * {@link detectWorkerRuntimeEnvironment} reports when the layout exists.
 */
export type WorkerRuntimeEnvironment = ComputeProvider | 'sandbox' | 'local';

export interface WorkerRuntimePaths {
  runtime: WorkerRuntimeEnvironment;
  sandboxRootDir: string;
  workspaceReposDir: string;
  vscodeUserDataDir: string;
}

type RuntimePathsWithoutEnvironment = Omit<WorkerRuntimePaths, 'runtime'>;
type ExistsSyncFn = (path: string) => boolean;

export const SANDBOX_WORKER_RUNTIME_PATHS: RuntimePathsWithoutEnvironment =
  Object.freeze({
    sandboxRootDir: SANDBOX_FILES_DIR,
    workspaceReposDir: `${SANDBOX_FILES_DIR}/repos`,
    vscodeUserDataDir: `${SANDBOX_FILES_DIR}/.vscode`,
  });

/**
 * Modal now mirrors the Vercel sandbox worker filesystem layout so the shared
 * worker bootstrap and runtime code can use the same paths across providers.
 */
export const MODAL_WORKER_RUNTIME_PATHS: RuntimePathsWithoutEnvironment =
  Object.freeze({
    ...SANDBOX_WORKER_RUNTIME_PATHS,
  });

/**
 * Daytona sandboxes boot from a snapshot built from the same worker image as
 * Modal, so they share the Vercel sandbox worker filesystem layout too.
 */
export const DAYTONA_WORKER_RUNTIME_PATHS: RuntimePathsWithoutEnvironment =
  Object.freeze({
    ...SANDBOX_WORKER_RUNTIME_PATHS,
  });

/**
 * E2B sandboxes boot from a template built from the same worker image as the
 * other hosted providers, so they share the Vercel sandbox worker filesystem
 * layout too.
 */
export const E2B_WORKER_RUNTIME_PATHS: RuntimePathsWithoutEnvironment =
  Object.freeze({
    ...SANDBOX_WORKER_RUNTIME_PATHS,
  });

export const LOCAL_WORKER_RUNTIME_PATHS: RuntimePathsWithoutEnvironment =
  Object.freeze({
    ...SANDBOX_WORKER_RUNTIME_PATHS,
  });

const RUNTIME_PATHS_BY_ENVIRONMENT: Record<
  WorkerRuntimeEnvironment,
  RuntimePathsWithoutEnvironment
> = {
  sandbox: SANDBOX_WORKER_RUNTIME_PATHS,
  modal: MODAL_WORKER_RUNTIME_PATHS,
  docker: SANDBOX_WORKER_RUNTIME_PATHS,
  daytona: DAYTONA_WORKER_RUNTIME_PATHS,
  e2b: E2B_WORKER_RUNTIME_PATHS,
  local: LOCAL_WORKER_RUNTIME_PATHS,
};

/**
 * Detects the active worker runtime environment by checking for the sandbox
 * filesystem root used inside Vercel-compatible runtimes.
 */
export function detectWorkerRuntimeEnvironment(
  existsSync: ExistsSyncFn,
): WorkerRuntimeEnvironment {
  return existsSync(SANDBOX_WORKER_RUNTIME_PATHS.sandboxRootDir)
    ? 'sandbox'
    : 'local';
}

/**
 * Returns runtime-specific paths used by worker setup/workspace logic.
 */
export function getWorkerRuntimePaths(
  runtime: WorkerRuntimeEnvironment,
): WorkerRuntimePaths {
  return {
    runtime,
    ...RUNTIME_PATHS_BY_ENVIRONMENT[runtime],
  };
}

/**
 * Resolves runtime paths either from an explicit provider/runtime or by
 * detecting the runtime from the filesystem.
 */
export function resolveWorkerRuntimePaths(options?: {
  provider?: ComputeProvider;
  runtime?: WorkerRuntimeEnvironment;
  existsSync?: ExistsSyncFn;
}): WorkerRuntimePaths {
  if (options?.provider) {
    return getWorkerRuntimePaths(options.provider);
  }

  if (options?.runtime) {
    return getWorkerRuntimePaths(options.runtime);
  }

  if (!options?.existsSync) {
    throw new Error(
      'resolveWorkerRuntimePaths requires either provider, runtime, or existsSync',
    );
  }

  const runtime = detectWorkerRuntimeEnvironment(options.existsSync);

  return getWorkerRuntimePaths(runtime);
}

/**
 * Resolves a provider string into a valid compute provider.
 * Falls back to "docker" (or a caller-provided fallback) for undefined
 * or unsupported values — including the removed "sandbox" (Vercel Sandbox)
 * vendor persisted on historical task runs.
 */
export function resolveComputeProviderTarget(
  provider: string | null | undefined,
  fallback: ComputeProvider = 'docker',
): ComputeProvider {
  if (provider && isComputeProvider(provider)) {
    return provider;
  }

  return fallback;
}
