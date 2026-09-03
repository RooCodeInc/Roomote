import {
  createAdoWorkItemComment,
  getAdoDeploymentUser,
  normalizeAdoLinkedAccountKey,
  type AdoCurrentUser,
} from '@roomote/ado';
import {
  authAccounts,
  db,
  repositories,
  and,
  desc,
  eq,
  type Repository,
} from '@roomote/db/server';

import type { WebhookResponse } from '../../types';
import { pickHostScopedRepository, toHostFromUrl } from '../utils';
import { buildSourceControlAccountLinkRequiredMessage } from '../source-control-account-linking';
import { resolveMappedEnvironmentId } from '../shared/repository-environment';
import {
  startSourceControlFastSessionTurn,
  type SourceControlFastDiscussion,
} from '@roomote/sdk/server';
import {
  buildSourceControlIssueMentionContext,
  resolveSourceControlIssueActiveTasks,
  SOURCE_CONTROL_FAST_UNAVAILABLE_MESSAGE,
} from '../shared/source-control-mention';
import {
  getAdoIdentityName,
  isRoomoteAdoIdentity,
} from './getAdoAutomationTargets';
import type {
  AdoIdentity,
  AdoWorkItemCommentedWebhook,
  AdoWorkItemResource,
} from './types';

const ADO_MENTION_HANDLE = '@roomote';

function isAdoMention(commentBody: string | undefined): boolean {
  return commentBody?.toLowerCase().includes(ADO_MENTION_HANDLE) ?? false;
}

function getDeploymentIdentityNames(user: AdoCurrentUser | null): string[] {
  if (!user) {
    return [];
  }

  return [user.uniqueName, user.displayName, user.providerDisplayName].filter(
    (value): value is string => Boolean(value?.trim()),
  );
}

function parseIdentityField(
  value: AdoIdentity | string | undefined,
): AdoIdentity | undefined {
  if (!value) {
    return undefined;
  }

  if (typeof value !== 'string') {
    return value;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }

  // ADO often serializes identities as `Display Name <email@org>`.
  const bracketMatch = trimmed.match(/^(.*?)\s*<([^>]+)>\s*$/);
  if (bracketMatch) {
    return {
      displayName: bracketMatch[1]?.trim() || undefined,
      uniqueName: bracketMatch[2]?.trim() || undefined,
    };
  }

  if (trimmed.includes('@')) {
    return { uniqueName: trimmed, displayName: trimmed };
  }

  return { displayName: trimmed };
}

function getAdoProjectId(
  permissions: Repository['permissions'],
): string | null {
  if (typeof permissions !== 'object' || permissions === null) {
    return null;
  }

  const projectId = (permissions as { projectId?: unknown }).projectId;
  return typeof projectId === 'string' && projectId.trim() ? projectId : null;
}

function getWorkItemNumber(resource: AdoWorkItemResource): number | null {
  const raw = resource.id ?? resource.fields?.['System.Id'];
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    return raw;
  }
  if (typeof raw === 'string' && raw.trim()) {
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/**
 * Official `workitem.commented` payloads put field values on `resource.fields`.
 * Some deployments also send a work-item-update `revision.fields.*.newValue`
 * shape; flatten that as a fallback without overwriting flat field values.
 */
function resolveWorkItemFields(
  resource: AdoWorkItemResource,
): Record<string, unknown> {
  const fields: Record<string, unknown> = {
    ...(resource.fields as Record<string, unknown> | undefined),
  };
  const revisionFields = resource.revision?.fields;
  if (!revisionFields) {
    return fields;
  }

  for (const [key, value] of Object.entries(revisionFields)) {
    if (fields[key] !== undefined) {
      continue;
    }
    if (value && typeof value === 'object' && 'newValue' in value) {
      fields[key] = (value as { newValue?: unknown }).newValue;
    }
  }

  return fields;
}

function getStringField(
  fields: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = fields[key];
  return typeof value === 'string' ? value : undefined;
}

function resolveCommentAuthor(
  resource: AdoWorkItemResource,
  fields: Record<string, unknown>,
): AdoIdentity | undefined {
  return (
    parseIdentityField(
      fields['System.ChangedBy'] as AdoIdentity | string | undefined,
    ) ??
    parseIdentityField(resource.revisedBy) ??
    parseIdentityField(resource.revision?.revisedBy)
  );
}

function extractUrlFromMarkdown(markdown: string | undefined): string | null {
  if (!markdown) {
    return null;
  }

  const match = markdown.match(/\((https?:\/\/[^)\s]+)\)/);
  return match?.[1] ?? null;
}

function getWorkItemUrl({
  resource,
  resourceContainers,
  projectName,
  workItemId,
  messageMarkdown,
}: {
  resource: AdoWorkItemResource;
  resourceContainers: AdoWorkItemCommentedWebhook['resourceContainers'];
  projectName: string | undefined;
  workItemId: number;
  messageMarkdown?: string;
}): string {
  const htmlUrl =
    resource._links?.html?.href?.trim() || resource._links?.web?.href?.trim();
  if (htmlUrl) {
    return htmlUrl;
  }

  const fromMessage = extractUrlFromMarkdown(messageMarkdown);
  if (fromMessage) {
    return fromMessage;
  }

  const baseUrl =
    resourceContainers?.project?.baseUrl?.replace(/\/$/, '') ||
    resourceContainers?.collection?.baseUrl?.replace(/\/$/, '') ||
    resourceContainers?.account?.baseUrl?.replace(/\/$/, '');

  if (baseUrl && projectName) {
    return `${baseUrl}/${encodeURIComponent(projectName)}/_workitems/edit/${workItemId}`;
  }

  if (baseUrl) {
    return `${baseUrl}/_workitems/edit/${workItemId}`;
  }

  return `workitem://${workItemId}`;
}

async function isDeploymentTokenAuthor(author: AdoIdentity): Promise<boolean> {
  try {
    const deploymentUser = await getAdoDeploymentUser();

    if (!deploymentUser) {
      return false;
    }

    if (author.id && deploymentUser.id === author.id) {
      return true;
    }

    const authorName = getAdoIdentityName(author)?.toLowerCase();

    return Boolean(
      authorName &&
      getDeploymentIdentityNames(deploymentUser).some(
        (deploymentName) => deploymentName.toLowerCase() === authorName,
      ),
    );
  } catch (error) {
    console.warn(
      `[handleAdoWorkItemComment] failed to resolve Azure DevOps deployment token identity: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );

    return false;
  }
}

async function postWorkItemMentionResponseComment({
  project,
  workItemId,
  body,
}: {
  project: string;
  workItemId: number;
  body: string;
}): Promise<void> {
  try {
    await createAdoWorkItemComment({
      project,
      workItemId,
      body,
    });
  } catch (error) {
    console.warn(
      `[handleAdoWorkItemComment] failed to post mention response comment on work item #${workItemId}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

/**
 * Resolve an active ADO repository for a work-item project. Prefers a repo
 * that already has an environment mapping so StandardTask launch can proceed.
 */
async function resolveAdoProjectRepository({
  projectId,
  webhookHost,
}: {
  projectId: string;
  webhookHost: string | null;
}): Promise<Repository | null> {
  const repoRows = await db.query.repositories.findMany({
    where: and(
      eq(repositories.sourceControlProvider, 'ado'),
      eq(repositories.isActive, true),
    ),
  });

  const projectRepos = repoRows.filter(
    (repo) => getAdoProjectId(repo.permissions) === projectId,
  );

  if (projectRepos.length === 0) {
    return null;
  }

  const hostScoped =
    pickHostScopedRepository(projectRepos, webhookHost) ?? projectRepos[0];
  if (!hostScoped) {
    return null;
  }

  // Prefer any project repo that maps to an environment; stay deterministic.
  const candidates = projectRepos
    .filter((repo) => {
      if (!webhookHost) {
        return true;
      }
      return !repo.host || repo.host === webhookHost;
    })
    .sort((a, b) => a.fullName.localeCompare(b.fullName));

  for (const candidate of candidates) {
    const environmentId = await resolveMappedEnvironmentId(candidate.id);
    if (environmentId) {
      return candidate;
    }
  }

  return hostScoped;
}

/**
 * Handle @mentions on Azure DevOps work item comments (not pull requests).
 * Starts a standard task bounded to a repository in the work item's project,
 * or continues an existing task already linked to the same work item.
 */
export async function handleAdoWorkItemComment(
  payload: AdoWorkItemCommentedWebhook,
): Promise<WebhookResponse> {
  const resource = payload.resource;
  const fields = resolveWorkItemFields(resource);
  const commentBody = getStringField(fields, 'System.History') ?? '';
  const author = resolveCommentAuthor(resource, fields);

  if (!isAdoMention(commentBody)) {
    return { status: 'ok', message: 'no_mention' };
  }

  const commenter = getAdoIdentityName(author);
  if (!author || !commenter) {
    return { status: 'ok', message: 'no_comment_author' };
  }

  if (
    isRoomoteAdoIdentity(commenter) ||
    (await isDeploymentTokenAuthor(author))
  ) {
    return { status: 'ok', message: 'roomote_authored_comment' };
  }

  const workItemId = getWorkItemNumber({
    ...resource,
    fields: {
      ...resource.fields,
      'System.Id':
        resource.fields?.['System.Id'] ??
        (fields['System.Id'] as string | number | undefined),
    },
  });
  if (workItemId == null) {
    return { status: 'ok', message: 'no_work_item_id' };
  }

  const projectId = payload.resourceContainers?.project?.id?.trim();
  if (!projectId) {
    return { status: 'ok', message: 'no_project_id' };
  }

  const projectName =
    getStringField(fields, 'System.TeamProject')?.trim() ||
    payload.resourceContainers?.project?.baseUrl
      ?.replace(/\/$/, '')
      .split('/')
      .pop();

  if (!projectName) {
    return { status: 'ok', message: 'no_project_name' };
  }

  const workItemUrl = getWorkItemUrl({
    resource,
    resourceContainers: payload.resourceContainers,
    projectName,
    workItemId,
    messageMarkdown: payload.message?.markdown,
  });
  const webhookHost = toHostFromUrl(
    workItemUrl.startsWith('http')
      ? workItemUrl
      : (payload.resourceContainers?.account?.baseUrl ??
          payload.resourceContainers?.collection?.baseUrl ??
          ''),
  );

  const repo = await resolveAdoProjectRepository({
    projectId,
    webhookHost,
  });

  if (!repo) {
    return {
      status: 'ok',
      message: `no_active_ado_repository_for_project:${projectId}`,
    };
  }

  const senderLinkedAccountKey = normalizeAdoLinkedAccountKey(
    author.uniqueName,
  );
  const linkedAccount = senderLinkedAccountKey
    ? await db.query.authAccounts.findFirst({
        where: and(
          eq(authAccounts.providerId, 'ado'),
          eq(authAccounts.accountId, senderLinkedAccountKey),
        ),
        orderBy: [desc(authAccounts.updatedAt)],
        columns: {
          userId: true,
        },
      })
    : null;

  if (!linkedAccount?.userId) {
    await postWorkItemMentionResponseComment({
      project: projectName,
      workItemId,
      body: await buildSourceControlAccountLinkRequiredMessage('ado'),
    });

    return { status: 'ok', message: 'account_link_required' };
  }

  const workItemTitle =
    getStringField(fields, 'System.Title')?.trim() ||
    `Work item #${workItemId}`;
  const description = fields['System.Description'];
  const workItemBody =
    typeof description === 'string' || description === null
      ? description
      : null;
  const workItemType = getStringField(fields, 'System.WorkItemType')?.trim();

  const discussion: SourceControlFastDiscussion = {
    provider: 'ado',
    host: repo.host ?? webhookHost ?? 'dev.azure.com',
    repositoryFullName: repo.fullName,
    kind: 'issues',
    number: workItemId,
  };
  const activeTasks = await resolveSourceControlIssueActiveTasks({
    provider: 'ado',
    repositoryFullName: repo.fullName,
    issueNumber: workItemId,
    host: repo.host,
  });

  const started = await startSourceControlFastSessionTurn({
    discussion,
    userId: linkedAccount.userId,
    senderDisplayName: commenter,
    question: commentBody,
    agentContext: buildSourceControlIssueMentionContext({
      providerLabel: 'Azure DevOps',
      issueLabel: 'Work item',
      repositoryFullName: repo.fullName,
      number: workItemId,
      title: workItemTitle,
      body: workItemBody,
      url: workItemUrl,
      commenter,
      commentBody,
      ...(workItemType ? { extraLines: [`Type: ${workItemType}`] } : {}),
    }),
    currentMessageId: `ado:work-item:${workItemId}:${resource.rev ?? Date.now()}`,
    activeTasks,
  });

  if (started.status !== 'queued') {
    await postWorkItemMentionResponseComment({
      project: projectName,
      workItemId,
      body: SOURCE_CONTROL_FAST_UNAVAILABLE_MESSAGE,
    });
    return { status: 'error', message: 'fast_unavailable' };
  }

  return {
    status: 'ok',
    message: 'fast_session_queued',
    metadata: { fastConversationId: started.fastConversationId },
  };
}
