import { upsertSourceControlPullRequestFactFromWebhook } from '@roomote/sdk/server';
import type { SourceControlProvider } from '@roomote/types';

import { toHostFromUrl } from './utils';

/**
 * Fire-and-forget PR-fact upsert for non-GitHub provider webhooks, mirroring
 * the GitHub handler's syncPullRequestFact. Terminal PR events (merged or
 * closed) flow into `pull_request_facts` immediately so the merged-PR audit
 * automations see them without waiting for the next scheduled sync pass.
 *
 * Timestamps missing from a provider's webhook payload fall back through the
 * available ones (merge time ≈ updated time) and finally to the event time;
 * the scheduled sync later overwrites the row with list-API values.
 */
export function scheduleSourceControlPullRequestFactSync(params: {
  provider: SourceControlProvider;
  repositoryFullName: string;
  pullRequest: {
    number: number;
    externalId?: number | null;
    title: string;
    url: string;
    authorLogin?: string | null;
    state: 'closed' | 'merged';
    createdAt?: string | null;
    updatedAt?: string | null;
    mergedAt?: string | null;
  };
}): void {
  const nowIso = new Date().toISOString();
  const { pullRequest } = params;

  const mergedAt =
    pullRequest.state === 'merged'
      ? (toValidIsoString(pullRequest.mergedAt) ??
        toValidIsoString(pullRequest.updatedAt) ??
        nowIso)
      : null;
  const updatedAt =
    toValidIsoString(pullRequest.updatedAt) ?? mergedAt ?? nowIso;
  const createdAt = toValidIsoString(pullRequest.createdAt) ?? updatedAt;

  upsertSourceControlPullRequestFactFromWebhook({
    provider: params.provider,
    repositoryFullName: params.repositoryFullName,
    // The PR web URL carries the instance host for every non-GitHub provider,
    // and `repositories.host` is derived from the same instance base URL, so
    // this scopes the fact write to the webhook's own instance instead of
    // every same-name repository across self-managed hosts.
    host: toHostFromUrl(pullRequest.url),
    pullRequest: {
      authorLogin: pullRequest.authorLogin ?? null,
      closedAt: mergedAt ?? updatedAt,
      createdAt,
      externalPullRequestId: pullRequest.externalId ?? pullRequest.number,
      mergedAt,
      number: pullRequest.number,
      state: pullRequest.state,
      title: pullRequest.title,
      updatedAt,
      url: pullRequest.url,
    },
  }).catch((error) =>
    console.warn(
      `[scheduleSourceControlPullRequestFactSync] Failed to upsert ${params.provider} PR fact for ${params.repositoryFullName}#${pullRequest.number}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    ),
  );
}

/**
 * Normalize a provider webhook timestamp to ISO-8601, accepting GitLab's
 * `YYYY-MM-DD HH:MM:SS UTC` format alongside ISO strings. Returns null for
 * missing or unparseable values.
 */
export function toValidIsoString(
  value: string | null | undefined,
): string | null {
  if (!value) {
    return null;
  }

  const direct = new Date(value);

  if (!Number.isNaN(direct.getTime())) {
    return direct.toISOString();
  }

  const gitLabStyle = value.match(
    /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) UTC$/,
  );

  if (gitLabStyle) {
    const parsed = new Date(`${gitLabStyle[1]}T${gitLabStyle[2]}Z`);

    if (!Number.isNaN(parsed.getTime())) {
      return parsed.toISOString();
    }
  }

  return null;
}
