import { getRedis } from '@roomote/redis';
import {
  buildIssueFixerFixPrompt,
  buildRepositoryCoverage,
  enqueueTask,
} from '@roomote/cloud-agents/server';
import {
  and,
  db,
  eq,
  getBackgroundAgentSettingsForDeployment,
  githubInstallations,
  recordAutomationRunOutcome,
  repositories,
} from '@roomote/db/server';
import { TaskPayloadKind } from '@roomote/types';

import type { WebhookResponse } from '../../types';

const LOG_PREFIX = '[handleGitHubIssueFixer]';

// Label bursts and duplicate deliveries of the same issue should not
// launch concurrent fixers for one issue.
const ISSUE_DEBOUNCE_SECONDS = 5 * 60;

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

function buildDebounceKey(repositoryId: string, issueNumber: number): string {
  return `github:issue-fixer:${repositoryId}:${issueNumber}`;
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
 * Launch one environment-backed implement-changes task the moment a GitHub
 * issue is opened or reopened, mirroring how Review Code and CI Failure Triage
 * start immediately from webhooks.
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

  const settings = await getBackgroundAgentSettingsForDeployment();

  if (settings.issueFixerFrequency === 'off') {
    return { status: 'ok', message: 'Triage GitHub Issues is disabled' };
  }

  const repositoryCoverage = await buildRepositoryCoverage([
    match.repositoryFullName,
  ]);
  const environmentId = repositoryCoverage[0]?.targetEnvironmentId;

  if (!environmentId) {
    return {
      status: 'ok',
      message:
        'Repository has no configured environment for Triage GitHub Issues',
    };
  }

  const redis = getRedis();
  const claim = await redis.set(
    buildDebounceKey(match.repositoryId, payload.issue.number),
    payload.issue.html_url,
    'EX',
    ISSUE_DEBOUNCE_SECONDS,
    'NX',
  );

  if (claim !== 'OK') {
    return {
      status: 'ok',
      message: 'Triage GitHub Issues already debounced for this issue',
    };
  }

  try {
    const description = buildIssueFixerFixPrompt({
      repositoryFullName: match.repositoryFullName,
      environmentId,
      trigger: 'webhook',
      repositoryCoverage,
      issue: {
        repositoryFullName: match.repositoryFullName,
        number: payload.issue.number,
        title: payload.issue.title,
        url: payload.issue.html_url,
        body: payload.issue.body,
        labels: issueLabels(payload.issue.labels),
        authorLogin: payload.issue.user?.login ?? null,
      },
    });

    const launchResult = await enqueueTask(
      {
        task: {
          type: TaskPayloadKind.StandardTask,
          payload: {
            repo: match.repositoryFullName,
            environmentId,
            selectedRepositories: [match.repositoryFullName],
            description,
            visibleInTranscript: false,
          },
        },
        initiator: { kind: 'automation', key: 'issue_fixer' },
        workflow: 'standard',
        surface: 'github',
        trigger: 'webhook',
        visibility: 'hidden',
      },
      {
        launchClass: 'automation',
      },
    );

    await recordAutomationRunOutcome(db, {
      key: 'issue_fixer',
      status: 'succeeded',
      at: new Date(),
    });

    return {
      status: 'ok',
      message: `Launched Triage GitHub Issues for ${match.repositoryFullName}#${payload.issue.number}`,
      metadata: { taskId: launchResult.taskId },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    await recordAutomationRunOutcome(db, {
      key: 'issue_fixer',
      status: 'failed',
      at: new Date(),
      error: message,
    }).catch(() => undefined);

    console.error(
      `${LOG_PREFIX} Failed to launch Triage GitHub Issues for ${match.repositoryFullName}#${payload.issue.number}: ${message}`,
    );

    return { status: 'error', message };
  }
}
