import { and, db, eq, or, repositories } from '@roomote/db/server';

import type { WebhookResponse } from '../../types';
import { launchIssueFixerTriage } from '../shared/issue-fixer-launch';
import { pickHostScopedRepository, toHostFromUrl } from '../utils';
import { isRoomoteGitLabUsername } from './getGitLabAutomationTargets';
import type { GitLabIssueWebhook } from './types';

const OPEN_ACTIONS = new Set(['open', 'reopen']);

/**
 * Launch issue implementation when a plain GitLab issue is opened/reopened.
 */
export async function handleGitLabIssue(
  payload: GitLabIssueWebhook,
): Promise<WebhookResponse> {
  const attrs = payload.object_attributes;
  const action = (attrs.action ?? '').toLowerCase();

  if (!OPEN_ACTIONS.has(action)) {
    return {
      status: 'ok',
      message: `Ignoring GitLab issue action: ${attrs.action ?? 'unknown'}`,
    };
  }

  const state = (attrs.state ?? '').toLowerCase();
  if (state && state !== 'opened' && state !== 'open' && state !== 'reopened') {
    return {
      status: 'ok',
      message: `Ignoring non-open GitLab issue: ${state}`,
    };
  }

  const authorUsername = payload.user?.username?.trim() ?? '';
  if (authorUsername && isRoomoteGitLabUsername(authorUsername)) {
    return {
      status: 'ok',
      message: 'Ignoring issue opened by Roomote GitLab identity',
    };
  }

  const projectId = String(payload.project.id);
  const fullName = payload.project.path_with_namespace;
  const webhookHost = toHostFromUrl(
    attrs.url ?? payload.project.web_url ?? payload.project.git_http_url ?? '',
  );

  const repoRows = await db.query.repositories.findMany({
    where: and(
      eq(repositories.sourceControlProvider, 'gitlab'),
      eq(repositories.isActive, true),
      fullName
        ? or(
            eq(repositories.externalRepoId, projectId),
            eq(repositories.fullName, fullName),
          )
        : eq(repositories.externalRepoId, projectId),
    ),
  });
  const repo = pickHostScopedRepository(repoRows, webhookHost);

  if (!repo) {
    return {
      status: 'ok',
      message: `No active GitLab repository for [${projectId}, ${fullName ?? 'unknown'}]`,
    };
  }

  const labels = (payload.labels ?? [])
    .map((label) => label?.title?.trim() ?? '')
    .filter(Boolean);

  return launchIssueFixerTriage({
    sourceControlProvider: 'gitlab',
    repositoryId: repo.id,
    repositoryFullName: repo.fullName,
    sourceControlHost: repo.host,
    continueMention: '@roomote',
    issue: {
      number: attrs.iid,
      title: attrs.title,
      url: attrs.url,
      body: attrs.description,
      labels,
      authorLogin: authorUsername || null,
    },
  });
}
