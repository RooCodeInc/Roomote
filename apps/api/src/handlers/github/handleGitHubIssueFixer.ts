import { resolveConfiguredGitHubAppSlug } from '@roomote/github';
import {
  and,
  db,
  eq,
  githubInstallations,
  repositories,
} from '@roomote/db/server';

import type { WebhookResponse } from '../../types';
import { launchIssueFixerTriage } from '../shared/issue-fixer-launch';

interface IssueFixerPayload {
  action: string;
  issue: {
    number: number;
    title: string;
    body?: string | null;
    html_url: string;
    state?: string | null;
    user?: { login?: string | null } | null;
    labels?: Array<string | { name?: string | null } | null> | null;
    pull_request?: unknown;
  };
  repository: {
    id: number;
    full_name: string;
  };
  installation?: { id: number } | null;
}

function issueLabels(labels: IssueFixerPayload['issue']['labels']): string[] {
  if (!labels) {
    return [];
  }

  return labels
    .map((label) => (typeof label === 'string' ? label : (label?.name ?? '')))
    .filter((name): name is string => Boolean(name));
}

/**
 * Launch one environment-backed implementation task the moment a GitHub
 * issue is opened or reopened (one task per issue event).
 */
export async function handleGitHubIssueFixer(
  payload: IssueFixerPayload,
): Promise<WebhookResponse> {
  if (payload.issue.pull_request) {
    return { status: 'ok', message: 'Ignoring pull request issue events' };
  }

  if (payload.issue.state && payload.issue.state !== 'open') {
    return { status: 'ok', message: 'Ignoring non-open issue' };
  }

  const installationId = payload.installation?.id;

  if (!installationId) {
    return { status: 'ok', message: 'Missing installation id' };
  }

  const [match] = await db
    .select({
      repositoryId: repositories.id,
      repositoryFullName: repositories.fullName,
      sourceControlHost: repositories.host,
    })
    .from(repositories)
    .innerJoin(
      githubInstallations,
      eq(githubInstallations.id, repositories.installationId),
    )
    .where(
      and(
        eq(githubInstallations.installationId, installationId),
        eq(repositories.githubRepoId, payload.repository.id),
        eq(repositories.isActive, true),
      ),
    )
    .limit(1);

  if (!match) {
    return { status: 'ok', message: 'Repository is not active in Roomote' };
  }

  const githubAppSlug = await resolveConfiguredGitHubAppSlug();

  return launchIssueFixerTriage({
    sourceControlProvider: 'github',
    repositoryId: match.repositoryId,
    repositoryFullName: match.repositoryFullName,
    sourceControlHost: match.sourceControlHost,
    githubAppSlug,
    issue: {
      number: payload.issue.number,
      title: payload.issue.title,
      url: payload.issue.html_url,
      body: payload.issue.body,
      labels: issueLabels(payload.issue.labels),
      authorLogin: payload.issue.user?.login ?? null,
    },
  });
}
