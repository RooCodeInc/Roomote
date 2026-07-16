import { sdk } from '@roomote/sdk/client';

import {
  applySourceControlTokenMetadata,
  ensureSourceControlTokenEnvFiles,
  runUnlessCredentialWriteBarrier,
} from '../../lib';
import type { HarnessLogger } from '../../logging';

const GITHUB_TOKEN_REFRESH_TICK_MS = 60 * 1000;
const GITHUB_TOKEN_REFRESH_RETRY_DELAY_MS = 5 * 60 * 1000;
const DEFAULT_GITHUB_TOKEN_REFRESH_INTERVAL_MS = 45 * 60 * 1000;

interface GitHubTokenRefreshOptions {
  runId: number;
  logger: Pick<HarnessLogger, 'info' | 'error'>;
}

export async function refreshGitHubToken({
  runId,
  logger,
}: GitHubTokenRefreshOptions): Promise<
  | {
      nextRefreshAtMs: number;
      source: 'user' | 'app';
      expiresAt: string | null;
    }
  | { nextRefreshAtMs: number; source: null; expiresAt: null }
> {
  try {
    logger.info(
      `[githubTokenRefresh] Refreshing source control token for task run #${runId}`,
    );

    const result = await sdk.taskRuns.refreshGitHubTokenWithMetadata({
      runId,
    });
    ensureSourceControlTokenEnvFiles();
    await applySourceControlTokenMetadata(result);

    const parsedNextRefreshAtMs = Date.parse(result.nextRefreshAt);
    const nextRefreshAtMs = Number.isNaN(parsedNextRefreshAtMs)
      ? Date.now() + DEFAULT_GITHUB_TOKEN_REFRESH_INTERVAL_MS
      : parsedNextRefreshAtMs;

    logger.info(
      `[githubTokenRefresh] Refreshed ${result.provider} token for task run #${runId} (source=${result.source}, nextRefreshAt=${result.nextRefreshAt}${result.expiresAt ? `, expiresAt=${result.expiresAt}` : ''})`,
    );

    return {
      nextRefreshAtMs,
      source: result.source,
      expiresAt: result.expiresAt,
    };
  } catch (error) {
    logger.error(
      `[githubTokenRefresh] Failed to refresh source control token for task run #${runId}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );

    return {
      nextRefreshAtMs: Date.now() + GITHUB_TOKEN_REFRESH_RETRY_DELAY_MS,
      source: null,
      expiresAt: null,
    };
  }
}

export function createGitHubTokenRefreshInterval(
  options: GitHubTokenRefreshOptions,
): NodeJS.Timeout {
  let nextRefreshAtMs = Date.now();
  let refreshInFlight = false;

  const tick = async () => {
    if (refreshInFlight || Date.now() < nextRefreshAtMs) {
      return;
    }

    refreshInFlight = true;
    try {
      // Skipped once the pre-snapshot credential scrub engages its barrier:
      // a refresh completing after the scrub would write token files back
      // onto the filesystem right before the provider snapshots it.
      const result = await runUnlessCredentialWriteBarrier(() =>
        refreshGitHubToken(options),
      );

      if (result) {
        nextRefreshAtMs = result.nextRefreshAtMs;
      }
    } finally {
      refreshInFlight = false;
    }
  };

  // Refresh once immediately so long workspace preparation time does not
  // consume most of the token window before runtime polling starts.
  void tick();

  return setInterval(() => {
    void tick();
  }, GITHUB_TOKEN_REFRESH_TICK_MS);
}
