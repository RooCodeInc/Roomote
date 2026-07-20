import type { FailedCiRun } from '@roomote/cloud-agents/server';
import {
  and,
  db,
  eq,
  githubInstallations,
  repositories,
} from '@roomote/db/server';
import { launchCiFailureTriageForFailedRun } from '@roomote/sdk/server';

import type { WebhookResponse } from '../../types';

interface WorkflowRunCompletedPayload {
  action: string;
  workflow_run: {
    id: number;
    name?: string | null;
    conclusion: string | null;
    head_branch: string | null;
    head_sha: string;
    html_url: string;
    event: string;
  };
  workflow?: { name?: string | null } | null;
  repository: {
    id: number;
    full_name: string;
    default_branch: string;
  };
  installation?: { id: number } | null;
}

/**
 * GitHub adapter: map workflow_run.completed into FailedCiRun and hand off to
 * the provider-neutral CI failure triage launch core.
 */
export async function handleWorkflowRunCompleted(
  payload: WorkflowRunCompletedPayload,
): Promise<WebhookResponse> {
  const run = payload.workflow_run;

  if (run.conclusion !== 'failure') {
    return { status: 'ok', message: 'Ignoring non-failure workflow run' };
  }

  if (
    !run.head_branch ||
    run.head_branch !== payload.repository.default_branch
  ) {
    return {
      status: 'ok',
      message: 'Ignoring workflow run outside the default branch',
    };
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

  const workflowName = run.name ?? payload.workflow?.name ?? 'unknown';
  const failedRun: FailedCiRun = {
    provider: 'github',
    repositoryId: match.repositoryId,
    repositoryFullName: match.repositoryFullName,
    externalRepoId: String(payload.repository.id),
    defaultBranch: payload.repository.default_branch,
    headBranch: run.head_branch,
    headSha: run.head_sha,
    workflowOrPipelineName: workflowName,
    runId: String(run.id),
    runUrl: run.html_url,
  };

  return launchCiFailureTriageForFailedRun(failedRun);
}
