import { and, db, eq, or, repositories } from '@roomote/db/server';

import type { WebhookResponse } from '../../types';
import { launchIssueFixerTriage } from '../shared/issue-fixer-launch';
import { pickHostScopedRepository, toHostFromUrl } from '../utils';
import {
  getGiteaUsername,
  isRoomoteGiteaUsername,
} from './getGiteaAutomationTargets';
import type { GiteaIssueWebhook } from './types';

const OPEN_ACTIONS = new Set(['opened', 'reopened']);

/**
 * Launch plan-only issue triage when a plain Gitea issue is opened/reopened.
 */
export async function handleGiteaIssue(
  payload: GiteaIssueWebhook,
): Promise<WebhookResponse> {
  const action = (payload.action ?? '').toLowerCase();

  if (!OPEN_ACTIONS.has(action)) {
    return {
      status: 'ok',
      message: `Ignoring Gitea issue action: ${payload.action ?? 'unknown'}`,
    };
  }

  // Gitea can deliver issue-shaped payloads for pull requests as well; skip those.
  if (payload.pull_request || payload.is_pull === true) {
    return { status: 'ok', message: 'Ignoring Gitea pull-request issue event' };
  }

  const issue = payload.issue;
  const state = (issue.state ?? '').toLowerCase();
  if (state && state !== 'open') {
    return { status: 'ok', message: `Ignoring non-open Gitea issue: ${state}` };
  }

  const authorUsername =
    getGiteaUsername(issue.user) ?? getGiteaUsername(payload.sender) ?? '';
  if (authorUsername && isRoomoteGiteaUsername(authorUsername)) {
    return {
      status: 'ok',
      message: 'Ignoring issue opened by Roomote Gitea identity',
    };
  }

  const repositoryId = String(payload.repository.id);
  const fullName = payload.repository.full_name;
  const webhookHost = toHostFromUrl(
    issue.html_url ?? payload.repository.html_url ?? '',
  );

  const repoRows = await db.query.repositories.findMany({
    where: and(
      eq(repositories.sourceControlProvider, 'gitea'),
      eq(repositories.isActive, true),
      fullName
        ? or(
            eq(repositories.externalRepoId, repositoryId),
            eq(repositories.fullName, fullName),
          )
        : eq(repositories.externalRepoId, repositoryId),
    ),
  });
  const repo = pickHostScopedRepository(repoRows, webhookHost);

  if (!repo) {
    return {
      status: 'ok',
      message: `No active Gitea repository for [${repositoryId}, ${fullName ?? 'unknown'}]`,
    };
  }

  const labels = (issue.labels ?? [])
    .map((label) =>
      typeof label === 'string' ? label.trim() : (label?.name?.trim() ?? ''),
    )
    .filter(Boolean);

  return launchIssueFixerTriage({
    sourceControlProvider: 'gitea',
    repositoryId: repo.id,
    repositoryFullName: repo.fullName,
    continueMention: '@roomote',
    issue: {
      number: issue.number,
      title: issue.title,
      url:
        issue.html_url ??
        `${payload.repository.html_url?.replace(/\/$/, '')}/issues/${issue.number}`,
      body: issue.body,
      labels,
      authorLogin: authorUsername || null,
    },
  });
}
