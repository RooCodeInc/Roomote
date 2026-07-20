import type { FailedCiRun } from '@roomote/cloud-agents/server';
import { and, db, eq, or, repositories } from '@roomote/db/server';
import { launchCiFailureTriageForFailedRun } from '@roomote/sdk/server';

import type { WebhookResponse } from '../../types';
import { pickHostScopedRepository, toHostFromUrl } from '../utils';
import type { GitLabPipelineWebhook } from './types';

/**
 * Nested/child pipeline sources that usually re-fire when a parent pipeline
 * fails. One investigation per repository is enough; skip these so a root
 * failure does not fan out into multiple triage tasks.
 */
const SKIP_PIPELINE_SOURCES = new Set([
  'parent_pipeline',
  'pipeline',
  'ondemand_dast_scan',
  'ondemand_dast_validation',
]);

function buildPipelineUrl(
  projectWebUrl: string | undefined,
  pipelineId: number,
  explicitUrl?: string | null,
): string {
  if (explicitUrl && explicitUrl.trim()) {
    return explicitUrl.trim();
  }
  const base = (projectWebUrl ?? '').replace(/\/$/, '');
  if (!base) {
    return `pipeline/${pipelineId}`;
  }
  return `${base}/-/pipelines/${pipelineId}`;
}

/**
 * GitLab adapter: map Pipeline Hook payloads into FailedCiRun and hand off to
 * the provider-neutral CI failure triage launch core.
 */
export async function handleGitLabPipeline(
  payload: GitLabPipelineWebhook,
): Promise<WebhookResponse> {
  const attrs = payload.object_attributes;
  const status = attrs.status.toLowerCase();

  if (status !== 'failed') {
    return {
      status: 'ok',
      message: `Ignoring non-failure GitLab pipeline: ${attrs.status}`,
    };
  }

  const source = (attrs.source ?? '').toLowerCase();
  if (source && SKIP_PIPELINE_SOURCES.has(source)) {
    return {
      status: 'ok',
      message: `Ignoring nested/child GitLab pipeline source: ${attrs.source}`,
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

  const defaultBranch =
    payload.project.default_branch?.trim() ||
    repo.defaultBranch?.trim() ||
    'main';
  const headBranch = attrs.ref.trim();

  if (!headBranch || headBranch !== defaultBranch) {
    return {
      status: 'ok',
      message: 'Ignoring GitLab pipeline outside the default branch',
    };
  }

  const headSha = (attrs.sha || payload.commit?.id || '').trim();
  if (!headSha) {
    return {
      status: 'ok',
      message: 'Ignoring GitLab pipeline without a head SHA',
    };
  }

  const workflowName = (attrs.name ?? '').trim() || 'pipeline';
  const runUrl = buildPipelineUrl(payload.project.web_url, attrs.id, attrs.url);

  const failedRun: FailedCiRun = {
    provider: 'gitlab',
    repositoryId: repo.id,
    repositoryFullName: repo.fullName,
    repositoryHost: repo.host,
    externalRepoId: projectId,
    defaultBranch,
    headBranch,
    headSha,
    workflowOrPipelineName: workflowName,
    runId: String(attrs.id),
    runUrl,
  };

  return launchCiFailureTriageForFailedRun(failedRun);
}
