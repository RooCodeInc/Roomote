import * as fs from 'node:fs';

const WORKER_RELEASE_TAG_PREFIX_PATTERN = /^worker(?:-preview)?-v(.+)$/;
const INSTALLED_WORKER_VERSION_FILE = '/sandbox/worker/VERSION';
const INSTALLED_WORKER_COMMIT_FILE = '/sandbox/worker/COMMIT';
const INSTALLED_WORKER_RELEASE_TAG_FILE = '/sandbox/worker/WORKER_RELEASE_TAG';

export interface WorkerReleaseMetadata {
  envContractVersion?: number;
  sentryRelease?: string;
  workerCommit?: string;
  workerReleaseTag?: string;
  workerVersion?: string;
}

type WorkerReleaseChannel = 'preview' | 'stable';

function resolveFallbackWorkerRelease(
  env: NodeJS.ProcessEnv,
): string | undefined {
  return (
    env.VERCEL_GIT_COMMIT_SHA?.trim() ||
    env.GITHUB_SHA?.trim() ||
    env.RELEASE_VERSION?.trim() ||
    undefined
  );
}

function readInstalledWorkerMetadata(filePath: string): string | undefined {
  try {
    const value = fs.readFileSync(filePath, 'utf8').trim();
    return value || undefined;
  } catch {
    return undefined;
  }
}

function parseWorkerVersionFromReleaseTag(
  workerReleaseTag: string | undefined,
): string | undefined {
  if (!workerReleaseTag) {
    return undefined;
  }

  return workerReleaseTag.match(WORKER_RELEASE_TAG_PREFIX_PATTERN)?.[1];
}

function resolveWorkerReleaseChannel(
  env: NodeJS.ProcessEnv,
): WorkerReleaseChannel {
  const explicitChannel = env.WORKER_RELEASE_CHANNEL?.trim();

  if (explicitChannel === 'preview' || explicitChannel === 'stable') {
    return explicitChannel;
  }

  const appEnv = env.R_APP_ENV?.trim() || env.APP_ENV?.trim();

  return appEnv === 'preview' ? 'preview' : 'stable';
}

/**
 * Mirrors `buildWorkerReleaseTag` in
 * `packages/compute-providers/src/sandbox/worker-release-selection.ts`.
 * This stays duplicated because the worker cannot import compute-providers
 * without pulling in heavy controller-side dependencies such as the Vercel
 * Sandbox SDK.
 */
function inferWorkerReleaseTagFromVersion(
  version: string | undefined,
  env: NodeJS.ProcessEnv,
): string | undefined {
  if (!version) {
    return undefined;
  }

  return resolveWorkerReleaseChannel(env) === 'preview'
    ? `worker-preview-v${version}`
    : `worker-v${version}`;
}

export function resolveWorkerReleaseMetadata(
  env: NodeJS.ProcessEnv = process.env,
): WorkerReleaseMetadata {
  const installedWorkerReleaseTag = readInstalledWorkerMetadata(
    INSTALLED_WORKER_RELEASE_TAG_FILE,
  );
  const installedWorkerVersion = readInstalledWorkerMetadata(
    INSTALLED_WORKER_VERSION_FILE,
  );
  const installedWorkerCommit = readInstalledWorkerMetadata(
    INSTALLED_WORKER_COMMIT_FILE,
  );
  const workerReleaseTag =
    env.WORKER_RELEASE_TAG?.trim() ||
    installedWorkerReleaseTag ||
    inferWorkerReleaseTagFromVersion(installedWorkerVersion, env);
  const fallbackWorkerRelease = resolveFallbackWorkerRelease(env);

  return {
    envContractVersion: 2,
    sentryRelease:
      workerReleaseTag || fallbackWorkerRelease || installedWorkerCommit,
    workerCommit: installedWorkerCommit,
    workerReleaseTag,
    workerVersion:
      installedWorkerVersion ||
      parseWorkerVersionFromReleaseTag(workerReleaseTag),
  };
}
