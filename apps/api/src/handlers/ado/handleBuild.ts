import type { FailedCiRun } from '@roomote/cloud-agents/server';
import {
  getAdoBuildFailureEvidence,
  getAdoBuildWebUrl,
  stripAdoGitRef,
} from '@roomote/ado';
import { and, db, eq, or, repositories } from '@roomote/db/server';
import { launchCiFailureTriageForFailedRun } from '@roomote/sdk/server';

import { logApiError } from '../../logging';
import type { WebhookResponse } from '../../types';
import { pickHostScopedRepository, toHostFromUrl } from '../utils';
import type { AdoBuildCompleteWebhook } from './types';

function getAdoOrganizationFromContainers(
  resourceContainers: AdoBuildCompleteWebhook['resourceContainers'],
  fallbackUrls: Array<string | undefined>,
): string {
  const baseUrl =
    resourceContainers?.account?.baseUrl ??
    resourceContainers?.collection?.baseUrl;

  if (baseUrl) {
    try {
      const parsed = new URL(baseUrl);
      const pathOrganization = parsed.pathname.split('/').filter(Boolean)[0];
      if (pathOrganization) {
        return decodeURIComponent(pathOrganization);
      }
      if (parsed.hostname.endsWith('.visualstudio.com')) {
        return parsed.hostname.split('.')[0] ?? parsed.hostname;
      }
    } catch {
      // Fall through.
    }
  }

  for (const candidate of fallbackUrls) {
    if (!candidate) {
      continue;
    }
    try {
      const parsed = new URL(candidate);
      if (parsed.hostname.endsWith('.visualstudio.com')) {
        return parsed.hostname.split('.')[0] ?? parsed.hostname;
      }
      const pathOrganization = parsed.pathname.split('/').filter(Boolean)[0];
      if (pathOrganization) {
        return decodeURIComponent(pathOrganization);
      }
    } catch {
      // Continue.
    }
  }

  return 'unknown';
}

function buildAdoRepositoryFullName(
  payload: AdoBuildCompleteWebhook,
): string | null {
  const repositoryName = payload.resource.repository?.name?.trim();
  const projectName = payload.resource.project?.name?.trim();
  if (!repositoryName || !projectName) {
    return null;
  }

  const organization = getAdoOrganizationFromContainers(
    payload.resourceContainers,
    [
      payload.resource._links?.web?.href,
      payload.resource.url,
      payload.resource.repository?.url,
    ],
  );

  return [organization, projectName, repositoryName].join('/');
}

function buildAdoBuildUrl(payload: AdoBuildCompleteWebhook): string {
  return getAdoBuildWebUrl({
    id: payload.resource.id,
    url: payload.resource.url,
    _links: payload.resource._links,
  });
}

/**
 * Azure DevOps adapter: map build.complete payloads into FailedCiRun and hand
 * off to the provider-neutral CI failure triage launch core.
 */
export async function handleAdoBuild(
  payload: AdoBuildCompleteWebhook,
): Promise<WebhookResponse> {
  const result = (payload.resource.result ?? '').trim().toLowerCase();
  if (result !== 'failed') {
    return {
      status: 'ok',
      message: `Ignoring non-failure Azure DevOps build: ${payload.resource.result ?? payload.resource.status ?? 'unknown'}`,
    };
  }

  const repositoryType = (
    payload.resource.repository?.type ?? ''
  ).toLowerCase();
  if (
    repositoryType &&
    repositoryType !== 'tfsgit' &&
    repositoryType !== 'git'
  ) {
    return {
      status: 'ok',
      message: `Ignoring non-Git Azure DevOps build repository type: ${payload.resource.repository?.type}`,
    };
  }

  const externalRepoId = payload.resource.repository?.id?.trim();
  if (!externalRepoId) {
    return {
      status: 'ok',
      message: 'Ignoring Azure DevOps build without a repository id',
    };
  }

  const fullName = buildAdoRepositoryFullName(payload);
  const webhookHost = toHostFromUrl(
    payload.resource._links?.web?.href ??
      payload.resource.url ??
      payload.resourceContainers?.account?.baseUrl ??
      payload.resourceContainers?.collection?.baseUrl ??
      '',
  );

  const repoRows = await db.query.repositories.findMany({
    where: and(
      eq(repositories.sourceControlProvider, 'ado'),
      eq(repositories.isActive, true),
      fullName
        ? or(
            eq(repositories.externalRepoId, externalRepoId),
            eq(repositories.fullName, fullName),
          )
        : eq(repositories.externalRepoId, externalRepoId),
    ),
  });
  const repo = pickHostScopedRepository(repoRows, webhookHost);

  if (!repo) {
    return {
      status: 'ok',
      message: `No active Azure DevOps repository for [${externalRepoId}, ${fullName ?? 'unknown'}]`,
    };
  }

  const defaultBranch = stripAdoGitRef(repo.defaultBranch) || 'main';
  const headBranch = stripAdoGitRef(payload.resource.sourceBranch);
  if (!headBranch || headBranch !== defaultBranch) {
    return {
      status: 'ok',
      message: 'Ignoring Azure DevOps build outside the default branch',
    };
  }

  const headSha = (payload.resource.sourceVersion ?? '').trim();
  if (!headSha) {
    return {
      status: 'ok',
      message: 'Ignoring Azure DevOps build without a head SHA',
    };
  }

  const workflowName =
    payload.resource.definition?.name?.trim() ||
    (payload.resource.buildNumber
      ? `build ${payload.resource.buildNumber}`
      : 'build');
  const runUrl = buildAdoBuildUrl(payload);

  const failureEvidence = await getAdoBuildFailureEvidence({
    repositoryFullName: repo.fullName,
    buildId: payload.resource.id,
  }).catch((error) => {
    logApiError(
      `[ADO] Failed to fetch build evidence for build ${payload.resource.id}`,
      error,
    );
    return null;
  });

  const failedRun: FailedCiRun = {
    provider: 'ado',
    repositoryId: repo.id,
    repositoryFullName: repo.fullName,
    repositoryHost: repo.host,
    externalRepoId,
    defaultBranch,
    headBranch,
    headSha,
    workflowOrPipelineName: workflowName,
    runId: String(payload.resource.id),
    runUrl,
    ...(failureEvidence ? { failureEvidence } : {}),
  };

  return launchCiFailureTriageForFailedRun(failedRun);
}
