import { rmSync } from 'fs';
import { homedir } from 'os';

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

function runScrubStep(
  step: string,
  logger: ScrubLogger,
  scrub: () => void,
): void {
  try {
    scrub();
  } catch (error) {
    logger.warn(
      `[scrubSandboxSecrets] Failed to ${step}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

/**
 * Remove secret material from the sandbox filesystem before a filesystem
 * snapshot is taken. Compute providers snapshot the entire filesystem, so
 * anything left on disk here persists in the snapshot image at the provider
 * and survives key rotation in the database.
 *
 * Everything scrubbed below is re-materialized from the dequeue/resume
 * response at the next run start (`injectEnvVars` plus the OpenCode
 * bootstrap), so restored sandboxes never rely on snapshotted credential
 * state:
 * - `~/.roomote/env.sh` holds plaintext exports of all deployment env vars,
 *   including inference provider keys, pasted Google service-account JSON,
 *   and the ChatGPT subscription OAuth record.
 * - `~/.roomote/gh-token` and the source-control credentials TSV hold git
 *   provider tokens.
 * - The OpenCode data dir holds the materialized `auth.json` and Google
 *   service-account JSON.
 */
export function scrubSandboxSecretsBeforeSnapshot(
  logger: ScrubLogger = console,
  openCodeRuntime: OpenCodeRuntime = {},
): void {
  logger.info(
    '[scrubSandboxSecrets] Removing credential material before filesystem snapshot',
  );

  runScrubStep('rewrite common env file without env vars', logger, () => {
    // Recreate the static token env scripts first: env.sh sources them, and
    // this also guarantees ~/.roomote exists.
    ensureSourceControlTokenEnvFiles();
    writeCommonEnvFile({});
  });

  runScrubStep('remove source-control credential files', logger, () =>
    removeSourceControlCredentialFiles(),
  );

  runScrubStep('remove OpenCode credential files', logger, () => {
    for (const filePath of resolveOpenCodeCredentialFilePaths(
      openCodeRuntime.homeDir ?? homedir(),
      openCodeRuntime.runtimeEnv ?? process.env,
    )) {
      rmSync(filePath, { force: true });
    }
  });
}
