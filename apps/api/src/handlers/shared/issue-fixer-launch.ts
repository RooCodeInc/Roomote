import {
  buildIssueFixerFixPrompt,
  enqueueTask,
} from '@roomote/cloud-agents/server';
import {
  asc,
  db,
  environmentRepositoryMappings,
  eq,
  getBackgroundAgentSettingsForDeployment,
  recordAutomationRunOutcome,
} from '@roomote/db/server';
import {
  TaskPayloadKind,
  type SourceControlProvider,
  type TaskSurface,
} from '@roomote/types';

import type { WebhookResponse } from '../../types';

const LOG_PREFIX = '[issueFixerLaunch]';

type IssueFixerSourceControlProvider = Extract<
  SourceControlProvider,
  'github' | 'gitlab' | 'gitea'
>;

type IssueFixerLaunchIssue = {
  number: number;
  title: string;
  url: string;
  body?: string | null;
  labels?: string[];
  authorLogin?: string | null;
};

/**
 * Resolve environment coverage from the concrete repository row id so same
 * owner/repo names on different providers (or hosts) cannot pick the wrong env.
 */
async function resolveMappedEnvironmentId(
  repositoryId: string,
): Promise<string | null> {
  const mappings = await db
    .select({
      environmentId: environmentRepositoryMappings.environmentId,
    })
    .from(environmentRepositoryMappings)
    .where(eq(environmentRepositoryMappings.repositoryId, repositoryId))
    .orderBy(asc(environmentRepositoryMappings.environmentId));

  if (mappings.length === 0) {
    return null;
  }

  return mappings[0]?.environmentId ?? null;
}

/**
 * Shared launch path for webhook-driven issue triage across supported SCMs.
 * Caller has already resolved the active Roomote repository row and normalized
 * the issue payload.
 */
export async function launchIssueFixerTriage({
  sourceControlProvider,
  repositoryId,
  repositoryFullName,
  issue,
  continueMention,
  githubAppSlug,
}: {
  sourceControlProvider: IssueFixerSourceControlProvider;
  /** Active Roomote repositories.id for provider/host-scoped env lookup. */
  repositoryId: string;
  repositoryFullName: string;
  issue: IssueFixerLaunchIssue;
  /** Provider-native follow-up tag humans should use (e.g. `@roomote`). */
  continueMention?: string;
  /** Required for GitHub-hosted prompt mention recovery. */
  githubAppSlug?: string;
}): Promise<WebhookResponse> {
  const settings = await getBackgroundAgentSettingsForDeployment();

  if (settings.issueFixerFrequency === 'off') {
    return { status: 'ok', message: 'Triage Issues is disabled' };
  }

  const environmentId = await resolveMappedEnvironmentId(repositoryId);

  if (!environmentId) {
    return {
      status: 'ok',
      message: 'Repository has no configured environment for Triage Issues',
    };
  }

  const repositoryCoverage = [
    {
      repositoryFullName,
      targetEnvironmentId: environmentId,
    },
  ];
  const surface = sourceControlProvider as TaskSurface;

  try {
    const description = buildIssueFixerFixPrompt({
      repositoryFullName,
      environmentId,
      trigger: 'webhook',
      sourceControlProvider,
      continueMention,
      githubAppSlug,
      repositoryCoverage,
      issue: {
        repositoryFullName,
        number: issue.number,
        title: issue.title,
        url: issue.url,
        body: issue.body,
        labels: issue.labels ?? [],
        authorLogin: issue.authorLogin ?? null,
      },
    });

    const launchResult = await enqueueTask(
      {
        task: {
          type: TaskPayloadKind.StandardTask,
          payload: {
            repo: repositoryFullName,
            environmentId,
            selectedRepositories: [repositoryFullName],
            description,
            visibleInTranscript: false,
            sourceControlProvider,
          },
        },
        initiator: { kind: 'automation', key: 'issue_fixer' },
        workflow: 'standard',
        surface,
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
      message: `Launched Triage Issues for ${repositoryFullName}#${issue.number}`,
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
      `${LOG_PREFIX} Failed to launch Triage Issues for ${repositoryFullName}#${issue.number} (${sourceControlProvider}): ${message}`,
    );

    return { status: 'error', message };
  }
}
