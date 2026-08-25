import { rmSync } from 'fs';
import { homedir } from 'os';

import { engageCredentialWriteBarrier } from '../../lib/credential-write-barrier';
import {
  ensureSourceControlTokenEnvFiles,
  removeSourceControlCredentialFiles,
} from '../../lib/github-token';
import { resolveOpenCodeCredentialFilePaths } from '../../run-task/agent-home';

import { writeCommonEnvFile } from './env-vars';

interface ScrubLogger {
  info(message: string): void;
  warn(message: string): void;
}

interface OpenCodeRuntime {
  homeDir?: string;
  runtimeEnv?: Record<string, string | undefined>;
}

interface ScrubSandboxSecretsResult {
  /** Human-readable names of scrub steps that failed. Empty on full success. */
  failedSteps: string[];
}

function runScrubStep(
  step: string,
  logger: ScrubLogger,
  scrub: () => void,
): boolean {
  try {
    scrub();
    return true;
  } catch (error) {
    logger.warn(
      `[scrubSandboxSecrets] Failed to ${step}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return false;
  }
}

/**
 * Remove secret material from the sandbox filesystem before a filesystem
 * snapshot is taken. Compute providers snapshot the entire filesystem, so
 * anything left on disk here persists in the snapshot image at the provider
 * and survives key rotation in the database.
 *
 * Current credentials scrubbed below are re-materialized from the
 * dequeue/resume response at the next run start, while legacy OpenCode
 * credentials are removed permanently because task inference is gateway-only:
 * - `~/.roomote/env.sh` holds plaintext exports of all deployment env vars,
 *   including inference provider keys and pasted Google service-account JSON.
 * - `~/.roomote/gh-token` and the source-control credentials TSV hold git
 *   provider tokens.
 * - Old snapshots can contain OpenCode `auth.json`; the data dir can also
 *   contain disabled Google service-account JSON.
 */
export async function scrubSandboxSecretsBeforeSnapshot(
  logger: ScrubLogger = console,
  openCodeRuntime: OpenCodeRuntime = {},
): Promise<ScrubSandboxSecretsResult> {
  logger.info(
    '[scrubSandboxSecrets] Removing credential material before filesystem snapshot',
  );

  // Quiesce credential writers (token refresh loop, env reloads) and wait for
  // in-flight writes to settle so nothing re-materializes files between this
  // scrub and the provider snapshot.
  await engageCredentialWriteBarrier();

  const failedSteps: string[] = [];
  const trackScrubStep = (step: string, scrub: () => void): void => {
    if (!runScrubStep(step, logger, scrub)) {
      failedSteps.push(step);
    }
  };

  trackScrubStep('rewrite common env file without env vars', () => {
    // Recreate the static token env scripts first: env.sh sources them, and
    // this also guarantees ~/.roomote exists.
    ensureSourceControlTokenEnvFiles();
    writeCommonEnvFile({});
  });

  trackScrubStep('remove source-control credential files', () =>
    removeSourceControlCredentialFiles(),
  );

  trackScrubStep('remove OpenCode credential files', () => {
    for (const filePath of resolveOpenCodeCredentialFilePaths(
      openCodeRuntime.homeDir ?? homedir(),
      openCodeRuntime.runtimeEnv ?? process.env,
    )) {
      rmSync(filePath, { force: true });
    }
  });

  return { failedSteps };
}
