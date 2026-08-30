import { z } from 'zod';

import {
  ALL_REPOSITORIES,
  buildRepositoryCloneUrl,
  filterRepositoryNamesForSourceControlProvider,
  stripCloneUrlUserInfo,
  type SourceControlProvider,
} from '@roomote/types';
import {
  type TaskRun,
  and,
  db,
  environments,
  repositories,
  eq,
  inArray,
} from '@roomote/db/server';

import {
  ADO_API_VERSION,
  DEFAULT_ADO_BASE_URL,
  AdoApiError,
  buildAdoApiUrl,
  buildAdoAuthorizationHeader,
  buildAdoBasicAuthHeader,
  buildAdoOrganizationApiBaseUrl,
  isEntraAccessToken,
  normalizeAdoBaseUrl as normalizeBaseUrl,
  normalizeAdoOrganization as normalizeOrganization,
  readAdoErrorMessage,
  resolveAdoBaseUrl,
  resolveAdoOrganization,
  resolveAdoToken,
  resolveAdoTokenWithMetadata,
  resolveAdoUsername,
  stripTrailingSlashes,
} from './credentials';

export * from './ci';
export {
  ADO_API_VERSION,
  AdoApiError,
  buildAdoApiUrl,
  buildAdoAuthorizationHeader,
  buildAdoOrganizationApiBaseUrl,
  clearAdoEntraTokenCache,
  describeAdoApiError,
  resolveAdoBaseUrl,
  resolveAdoOrganization,
  resolveAdoToken,
  resolveAdoUsername,
  validateAdoDelegatedCredentials,
  validateAdoEntraCredentials,
  validateAdoToken,
  type AdoTokenValidationResult,
} from './credentials';

const ADO_PROVIDER = 'ado' satisfies SourceControlProvider;
// `/_apis/connectionData` is a preview-only resource: Azure DevOps answers
// plain `7.1` (and `7.0`) with a 400 demanding the `-preview` suffix.
const ADO_CONNECTION_DATA_API_VERSION = '7.1-preview';
const DEFAULT_ADO_GIT_USERNAME = 'ado';
const ADO_SERVICE_HOOK_ENSURE_CONCURRENCY = 5;
const ADO_SERVICE_HOOK_PUBLISHER_ID = 'tfs';
const ADO_SERVICE_HOOK_CONSUMER_ID = 'webHooks';
const ADO_SERVICE_HOOK_CONSUMER_ACTION_ID = 'httpRequest';
const ADO_WEBHOOK_BASIC_AUTH_USERNAME = 'roomote';

const ADO_PULL_REQUEST_SERVICE_HOOK_EVENTS: readonly {
  eventType: string;
  publisherInputs?: Record<string, string>;
  webhookQueryParams?: Record<string, string>;
}[] = [
  { eventType: 'git.pullrequest.created' },
  {
    eventType: 'git.pullrequest.updated',
    publisherInputs: { notificationType: 'PushNotification' },
    webhookQueryParams: { notificationType: 'PushNotification' },
  },
  {
    eventType: 'git.pullrequest.updated',
    publisherInputs: { notificationType: 'StatusUpdateNotification' },
    webhookQueryParams: { notificationType: 'StatusUpdateNotification' },
  },
  { eventType: 'ms.vss-code.git-pullrequest-comment-event' },
  { eventType: 'git.push' },
] as const;

/** Project-scoped events (no repository publisher input). */
const ADO_PROJECT_SERVICE_HOOK_EVENTS: readonly {
  eventType: string;
  publisherInputs?: Record<string, string>;
  resourceVersion?: string;
}[] = [
  { eventType: 'workitem.commented' },
  // CI Failure Triage: completed builds (result filtered in the handler).
  // resourceVersion 1.0 sends the legacy XAML build shape with no `result`,
  // `sourceBranch`, or `repository`; 2.0 sends the modern Build resource the
  // build.complete handler parses.
  { eventType: 'build.complete', resourceVersion: '2.0' },
] as const;

const adoWorkItemCommentSchema = z
  .object({
    id: z.union([z.string(), z.number()]).optional(),
  })
  .passthrough();

const adoProjectSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullable().optional(),
  state: z.string().optional(),
  visibility: z.string().optional(),
});

const adoRepositorySchema = z.object({
  id: z.string(),
  name: z.string(),
  project: adoProjectSchema,
  defaultBranch: z.string().nullable().optional(),
  remoteUrl: z.string().nullable().optional(),
  webUrl: z.string().nullable().optional(),
  isDisabled: z.boolean().optional(),
});

const adoRepositoryListResponseSchema = z.object({
  count: z.number().optional(),
  value: z.array(adoRepositorySchema),
});
const adoServiceHookSubscriptionSchema = z
  .object({
    id: z.string(),
    publisherId: z.string().optional(),
    eventType: z.string(),
    resourceVersion: z.string().optional(),
    consumerId: z.string().optional(),
    consumerActionId: z.string().optional(),
    publisherInputs: z.record(z.string()).optional(),
    consumerInputs: z.record(z.string()).optional(),
  })
  .passthrough();
const adoServiceHookSubscriptionListResponseSchema = z.object({
  count: z.number().optional(),
  value: z.array(adoServiceHookSubscriptionSchema),
});
const adoCurrentUserSchema = z
  .object({
    id: z.string(),
    displayName: z.string().optional(),
    uniqueName: z.string().optional(),
    providerDisplayName: z.string().optional(),
  })
  .passthrough();
const adoConnectionDataSchema = z
  .object({
    authenticatedUser: adoCurrentUserSchema,
  })
  .passthrough();
const adoCreatedCommentSchema = z
  .object({ id: z.number().int().optional() })
  .passthrough();
const adoThreadSchema = z
  .object({
    id: z.number().int(),
    comments: z.array(adoCreatedCommentSchema).optional(),
  })
  .passthrough();

export type AdoRepository = z.infer<typeof adoRepositorySchema>;
export type AdoCurrentUser = z.infer<typeof adoCurrentUserSchema>;
type AdoServiceHookSubscription = z.infer<
  typeof adoServiceHookSubscriptionSchema
>;
export type AdoRepositoryCredential = {
  host: string;
  repositoryFullName: string;
  username: string;
  token: string;
  authScheme: 'basic' | 'bearer';
  originBaseUrl: string;
};

export type AdoRepositoryValues = {
  sourceControlProvider: typeof ADO_PROVIDER;
  installationId: null;
  userId: null;
  githubRepoId: null;
  externalRepoId: string;
  host: string;
  name: string;
  fullName: string;
  description: string | null;
  private: boolean;
  defaultBranch: string;
  cloneUrl: string;
  htmlUrl: string;
  permissions: Record<string, unknown>;
  isActive: true;
  linkedByUserId: string;
};

export type ListAdoRepositoriesOptions = {
  token?: string;
  organization?: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  stopAfter?: number;
};

export type AdoServiceHookEnsureResult = {
  repositoryFullName: string;
  status: 'created' | 'updated' | 'failed';
  error?: string;
};

let cachedAdoDeploymentUser: {
  token: string;
  organizationApiBaseUrl: string;
  user: AdoCurrentUser;
} | null = null;

async function requestAdoJson<T>({
  organizationApiBaseUrl,
  fetchImpl = fetch,
  method = 'GET',
  path,
  params,
  token,
  body,
  schema,
}: {
  organizationApiBaseUrl: string;
  fetchImpl?: typeof fetch;
  method?: 'GET' | 'POST' | 'PUT';
  path: string;
  params: Record<string, string | number | boolean>;
  token: string;
  body?: Record<string, unknown>;
  schema: z.ZodType<T>;
}): Promise<{ data: T; response: Response }> {
  const response = await fetchImpl(
    buildAdoApiUrl(organizationApiBaseUrl, path, params),
    {
      method,
      headers: {
        Accept: 'application/json',
        Authorization: buildAdoAuthorizationHeader(token),
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    },
  );

  if (![200, 201].includes(response.status)) {
    throw new AdoApiError(
      response.status,
      response.statusText,
      readAdoErrorMessage(await response.text().catch(() => '')),
    );
  }

  return {
    data: schema.parse(await response.json()),
    response,
  };
}

export function parseAdoRepositoryFullName(repositoryFullName: string): {
  organization: string;
  project: string;
  repository: string;
} {
  const [organization, project, repository, ...extra] =
    repositoryFullName.split('/');

  if (!organization || !project || !repository || extra.length > 0) {
    throw new Error(
      `Azure DevOps repository names must be in organization/project/repository form: ${repositoryFullName}`,
    );
  }

  return { organization, project, repository };
}

export async function resolveAdoOrganizationApiBaseUrl({
  organization,
  baseUrl,
  organizationApiBaseUrl,
}: {
  organization?: string;
  baseUrl?: string;
  organizationApiBaseUrl?: string;
} = {}): Promise<string | null> {
  if (organizationApiBaseUrl?.trim()) {
    return stripTrailingSlashes(organizationApiBaseUrl);
  }

  const resolvedOrganization = organization ?? (await resolveAdoOrganization());

  if (!resolvedOrganization?.trim()) {
    return null;
  }

  return buildAdoOrganizationApiBaseUrl({
    baseUrl:
      baseUrl === undefined
        ? await resolveAdoBaseUrl()
        : normalizeBaseUrl(baseUrl),
    organization: resolvedOrganization,
  });
}

export async function getAdoDeploymentUser(options?: {
  token?: string;
  organization?: string;
  baseUrl?: string;
  organizationApiBaseUrl?: string;
  fetchImpl?: typeof fetch;
}): Promise<AdoCurrentUser | null> {
  const adoToken = options?.token ?? (await resolveAdoToken());

  if (!adoToken?.trim()) {
    return null;
  }

  const organizationApiBaseUrl = await resolveAdoOrganizationApiBaseUrl({
    organization: options?.organization,
    baseUrl: options?.baseUrl,
    organizationApiBaseUrl: options?.organizationApiBaseUrl,
  });

  if (!organizationApiBaseUrl) {
    return null;
  }

  if (
    cachedAdoDeploymentUser?.token === adoToken &&
    cachedAdoDeploymentUser.organizationApiBaseUrl === organizationApiBaseUrl
  ) {
    return cachedAdoDeploymentUser.user;
  }

  const { data } = await requestAdoJson({
    organizationApiBaseUrl,
    fetchImpl: options?.fetchImpl,
    path: '/_apis/connectionData',
    params: { 'api-version': ADO_CONNECTION_DATA_API_VERSION },
    token: adoToken,
    schema: adoConnectionDataSchema,
  });

  cachedAdoDeploymentUser = {
    token: adoToken,
    organizationApiBaseUrl,
    user: data.authenticatedUser,
  };

  return data.authenticatedUser;
}

export function clearAdoDeploymentUserCache(): void {
  cachedAdoDeploymentUser = null;
}

/**
 * Normalizes an Azure DevOps identity to the key used for linked-account
 * matching. Azure DevOps exposes a user's identity under different ids per
 * surface: the Entra OAuth `connectionData` returns a vssps user id, while
 * pull request comment webhooks deliver an org identity id — the two never
 * match, and neither equals the Entra object id. The `uniqueName` (UPN /
 * email) is the one value present identically on both surfaces, so linked
 * accounts key off it. Lowercasing and trimming keeps the link side and the
 * webhook side in agreement.
 */
export function normalizeAdoLinkedAccountKey(
  value: string | null | undefined,
): string | null {
  const normalized = value?.trim().toLowerCase();

  return normalized ? normalized : null;
}

const adoPullRequestDetailsSchema = z
  .object({ pullRequestId: z.number() })
  .passthrough();

/**
 * Fetches a pull request by repository UUID and pull request number.
 * Returns the raw Azure DevOps pull request resource (repository, refs,
 * identities, ...), used to rehydrate webhook payloads that only carry
 * resource links.
 */
export async function getAdoPullRequest({
  repositoryId,
  pullRequestNumber,
  token,
  organization,
  baseUrl,
  organizationApiBaseUrl,
  fetchImpl,
}: {
  repositoryId: string;
  pullRequestNumber: number;
  token?: string;
  organization?: string;
  baseUrl?: string;
  organizationApiBaseUrl?: string;
  fetchImpl?: typeof fetch;
}): Promise<Record<string, unknown>> {
  const adoToken = token ?? (await resolveAdoToken());

  if (!adoToken?.trim()) {
    throw new Error(
      'ADO_TOKEN is required to read Azure DevOps pull requests.',
    );
  }

  const resolvedOrganizationApiBaseUrl = await resolveAdoOrganizationApiBaseUrl(
    { organization, baseUrl, organizationApiBaseUrl },
  );

  if (!resolvedOrganizationApiBaseUrl) {
    throw new Error(
      'ADO_ORGANIZATION is required to read Azure DevOps pull requests.',
    );
  }

  const { data } = await requestAdoJson({
    organizationApiBaseUrl: resolvedOrganizationApiBaseUrl,
    fetchImpl,
    path: `/_apis/git/repositories/${encodeURIComponent(
      repositoryId,
    )}/pullRequests/${pullRequestNumber}`,
    params: { 'api-version': ADO_API_VERSION },
    token: adoToken,
    schema: adoPullRequestDetailsSchema,
  });

  return data;
}

function normalizeAdoParentCommentId(
  parentCommentId: string | number | undefined,
): number {
  const parsedParentCommentId = Number(parentCommentId);

  return Number.isInteger(parsedParentCommentId) && parsedParentCommentId > 0
    ? parsedParentCommentId
    : 1;
}

export async function createAdoPullRequestComment({
  repositoryFullName,
  repositoryId,
  pullRequestNumber,
  threadId,
  parentCommentId,
  body,
  token,
  organization,
  baseUrl,
  organizationApiBaseUrl,
  fetchImpl,
}: {
  repositoryFullName: string;
  repositoryId: string;
  pullRequestNumber: number;
  threadId?: string;
  parentCommentId?: string | number;
  body: string;
  token?: string;
  organization?: string;
  baseUrl?: string;
  organizationApiBaseUrl?: string;
  fetchImpl?: typeof fetch;
}): Promise<{ threadId: string; commentId: string | null }> {
  const adoToken = token ?? (await resolveAdoToken());

  if (!adoToken?.trim()) {
    throw new Error(
      'ADO_TOKEN is required to create Azure DevOps pull request comments.',
    );
  }

  const parsedRepository = parseAdoRepositoryFullName(repositoryFullName);
  const resolvedOrganizationApiBaseUrl = await resolveAdoOrganizationApiBaseUrl(
    {
      organization: organization ?? parsedRepository.organization,
      baseUrl,
      organizationApiBaseUrl,
    },
  );

  if (!resolvedOrganizationApiBaseUrl) {
    throw new Error(
      'ADO_ORGANIZATION is required to create Azure DevOps pull request comments.',
    );
  }

  const threadsPath = `/${encodeURIComponent(
    parsedRepository.project,
  )}/_apis/git/repositories/${encodeURIComponent(
    repositoryId,
  )}/pullRequests/${pullRequestNumber}/threads`;

  if (threadId?.trim()) {
    const { data } = await requestAdoJson({
      organizationApiBaseUrl: resolvedOrganizationApiBaseUrl,
      fetchImpl,
      method: 'POST',
      path: `${threadsPath}/${encodeURIComponent(threadId)}/comments`,
      params: { 'api-version': ADO_API_VERSION },
      token: adoToken,
      body: {
        content: body,
        commentType: 'text',
        parentCommentId: normalizeAdoParentCommentId(parentCommentId),
      },
      schema: adoCreatedCommentSchema,
    });

    return {
      threadId,
      commentId: data.id != null ? String(data.id) : null,
    };
  }

  const { data } = await requestAdoJson({
    organizationApiBaseUrl: resolvedOrganizationApiBaseUrl,
    fetchImpl,
    method: 'POST',
    path: threadsPath,
    params: { 'api-version': ADO_API_VERSION },
    token: adoToken,
    body: {
      comments: [{ content: body, commentType: 'text', parentCommentId: 0 }],
      status: 'active',
    },
    schema: adoThreadSchema,
  });

  return {
    threadId: String(data.id),
    commentId:
      data.comments?.[0]?.id != null ? String(data.comments[0].id) : null,
  };
}

export async function createAdoWorkItemComment({
  project,
  workItemId,
  body,
  token,
  organization,
  baseUrl,
  organizationApiBaseUrl,
  fetchImpl,
}: {
  project: string;
  workItemId: number;
  body: string;
  token?: string;
  organization?: string;
  baseUrl?: string;
  organizationApiBaseUrl?: string;
  fetchImpl?: typeof fetch;
}): Promise<{ commentId: string | null }> {
  const adoToken = token ?? (await resolveAdoToken());

  if (!adoToken?.trim()) {
    throw new Error(
      'ADO_TOKEN is required to create Azure DevOps work item comments.',
    );
  }

  const resolvedOrganizationApiBaseUrl = await resolveAdoOrganizationApiBaseUrl(
    {
      organization,
      baseUrl,
      organizationApiBaseUrl,
    },
  );

  if (!resolvedOrganizationApiBaseUrl) {
    throw new Error(
      'ADO_ORGANIZATION is required to create Azure DevOps work item comments.',
    );
  }

  const { data } = await requestAdoJson({
    organizationApiBaseUrl: resolvedOrganizationApiBaseUrl,
    fetchImpl,
    method: 'POST',
    path: `/${encodeURIComponent(project)}/_apis/wit/workItems/${workItemId}/comments`,
    params: { 'api-version': '7.1-preview.4' },
    token: adoToken,
    body: { text: body },
    schema: adoWorkItemCommentSchema,
  });

  return {
    commentId: data.id != null ? String(data.id) : null,
  };
}

export async function listAdoRepositories({
  token,
  organization,
  baseUrl,
  fetchImpl,
  stopAfter,
}: ListAdoRepositoriesOptions = {}): Promise<AdoRepository[]> {
  const adoToken = token ?? (await resolveAdoToken());

  if (!adoToken?.trim()) {
    throw new Error('ADO_TOKEN is required to sync Azure DevOps repositories.');
  }

  const resolvedOrganization = organization ?? (await resolveAdoOrganization());

  if (!resolvedOrganization?.trim()) {
    throw new Error(
      'ADO_ORGANIZATION is required to sync Azure DevOps repositories.',
    );
  }

  const organizationApiBaseUrl = buildAdoOrganizationApiBaseUrl({
    baseUrl:
      baseUrl === undefined
        ? await resolveAdoBaseUrl()
        : normalizeBaseUrl(baseUrl),
    organization: resolvedOrganization,
  });
  const { data } = await requestAdoJson({
    organizationApiBaseUrl,
    fetchImpl,
    path: '/_apis/git/repositories',
    params: {
      'api-version': ADO_API_VERSION,
      includeHidden: false,
      includeAllUrls: true,
    },
    token: adoToken,
    schema: adoRepositoryListResponseSchema,
  });
  const repositoriesList = data.value.filter(
    (repository) => repository.isDisabled !== true,
  );

  return stopAfter === undefined
    ? repositoriesList
    : repositoriesList.slice(0, stopAfter);
}

function buildAdoWebhookHeaderCredentials(secretToken: string): string {
  return `X-Roomote-Webhook-Secret:${secretToken}`;
}

function buildAdoServiceHookWebhookUrl({
  webhookUrl,
  queryParams,
}: {
  webhookUrl: string;
  queryParams?: Record<string, string>;
}): string {
  if (!queryParams || Object.keys(queryParams).length === 0) {
    return webhookUrl;
  }

  const url = new URL(webhookUrl);

  for (const [key, value] of Object.entries(queryParams)) {
    url.searchParams.set(key, value);
  }

  return url.toString();
}

function buildAdoServiceHookSubscriptionBody({
  repositoryId,
  projectId,
  eventType,
  publisherInputs = {},
  resourceVersion,
  webhookUrl,
  secretToken,
}: {
  repositoryId?: string;
  projectId: string;
  eventType: string;
  publisherInputs?: Record<string, string>;
  resourceVersion?: string;
  webhookUrl: string;
  secretToken: string;
}) {
  return {
    publisherId: ADO_SERVICE_HOOK_PUBLISHER_ID,
    eventType,
    resourceVersion: resourceVersion ?? '1.0',
    consumerId: ADO_SERVICE_HOOK_CONSUMER_ID,
    consumerActionId: ADO_SERVICE_HOOK_CONSUMER_ACTION_ID,
    publisherInputs: {
      projectId,
      ...(repositoryId ? { repository: repositoryId } : {}),
      ...publisherInputs,
    },
    consumerInputs: {
      url: webhookUrl,
      basicAuthUsername: ADO_WEBHOOK_BASIC_AUTH_USERNAME,
      basicAuthPassword: secretToken,
      httpHeaders: buildAdoWebhookHeaderCredentials(secretToken),
      resourceDetailsToSend: 'all',
      messagesToSend: 'all',
      detailedMessagesToSend: 'all',
    },
  };
}

async function listAdoServiceHookSubscriptions({
  organizationApiBaseUrl,
  token,
  fetchImpl,
}: {
  organizationApiBaseUrl: string;
  token: string;
  fetchImpl?: typeof fetch;
}): Promise<AdoServiceHookSubscription[]> {
  const { data } = await requestAdoJson({
    organizationApiBaseUrl,
    fetchImpl,
    path: '/_apis/hooks/subscriptions',
    params: {
      'api-version': ADO_API_VERSION,
      publisherId: ADO_SERVICE_HOOK_PUBLISHER_ID,
      consumerId: ADO_SERVICE_HOOK_CONSUMER_ID,
      consumerActionId: ADO_SERVICE_HOOK_CONSUMER_ACTION_ID,
    },
    token,
    schema: adoServiceHookSubscriptionListResponseSchema,
  });

  return data.value;
}

function hasMatchingAdoPublisherInputs({
  subscription,
  repositoryId,
  projectId,
  publisherInputs,
}: {
  subscription: AdoServiceHookSubscription;
  repositoryId?: string;
  projectId: string;
  publisherInputs?: Record<string, string>;
}): boolean {
  const existingInputs = subscription.publisherInputs ?? {};

  if (existingInputs.projectId !== projectId) {
    return false;
  }

  if (repositoryId) {
    if (existingInputs.repository !== repositoryId) {
      return false;
    }
  } else if (existingInputs.repository) {
    // Project-scoped hooks must not match repository-scoped subscriptions.
    return false;
  }

  for (const [key, value] of Object.entries(publisherInputs ?? {})) {
    if (existingInputs[key] !== value) {
      return false;
    }
  }

  return true;
}

function findAdoServiceHookSubscription({
  subscriptions,
  eventType,
  repositoryId,
  projectId,
  publisherInputs,
  webhookUrl,
  legacyWebhookUrl,
}: {
  subscriptions: AdoServiceHookSubscription[];
  eventType: string;
  repositoryId?: string;
  projectId: string;
  publisherInputs?: Record<string, string>;
  webhookUrl: string;
  legacyWebhookUrl?: string;
}): AdoServiceHookSubscription | undefined {
  const acceptedWebhookUrls = new Set(
    [webhookUrl, legacyWebhookUrl].filter(Boolean),
  );

  return subscriptions.find(
    (subscription) =>
      subscription.publisherId === ADO_SERVICE_HOOK_PUBLISHER_ID &&
      subscription.consumerId === ADO_SERVICE_HOOK_CONSUMER_ID &&
      subscription.consumerActionId === ADO_SERVICE_HOOK_CONSUMER_ACTION_ID &&
      subscription.eventType === eventType &&
      acceptedWebhookUrls.has(subscription.consumerInputs?.url ?? '') &&
      hasMatchingAdoPublisherInputs({
        subscription,
        repositoryId,
        projectId,
        publisherInputs,
      }),
  );
}

async function upsertAdoServiceHookSubscription({
  repositoryId,
  projectId,
  eventType,
  publisherInputs,
  resourceVersion,
  webhookUrl,
  secretToken,
  subscriptions,
  token,
  organizationApiBaseUrl,
  fetchImpl,
}: {
  repositoryId?: string;
  projectId: string;
  eventType: string;
  publisherInputs?: Record<string, string>;
  resourceVersion?: string;
  webhookUrl: string;
  secretToken: string;
  subscriptions: AdoServiceHookSubscription[];
  token: string;
  organizationApiBaseUrl: string;
  fetchImpl?: typeof fetch;
}): Promise<'created' | 'updated'> {
  const body = buildAdoServiceHookSubscriptionBody({
    repositoryId,
    projectId,
    eventType,
    publisherInputs,
    resourceVersion,
    webhookUrl,
    secretToken,
  });
  const existingSubscription = findAdoServiceHookSubscription({
    subscriptions,
    eventType,
    repositoryId,
    projectId,
    publisherInputs,
    webhookUrl,
    legacyWebhookUrl: webhookUrl,
  });

  if (!existingSubscription) {
    await requestAdoJson({
      organizationApiBaseUrl,
      fetchImpl,
      method: 'POST',
      path: '/_apis/hooks/subscriptions',
      params: { 'api-version': ADO_API_VERSION },
      token,
      body,
      schema: adoServiceHookSubscriptionSchema,
    });
    return 'created';
  }

  await requestAdoJson({
    organizationApiBaseUrl,
    fetchImpl,
    method: 'PUT',
    path: `/_apis/hooks/subscriptions/${encodeURIComponent(
      existingSubscription.id,
    )}`,
    params: { 'api-version': ADO_API_VERSION },
    token,
    body,
    schema: adoServiceHookSubscriptionSchema,
  });
  return 'updated';
}

async function ensureAdoRepositoryServiceHooks({
  repositoryId,
  projectId,
  subscriptions,
  webhookUrl,
  secretToken,
  token,
  organizationApiBaseUrl,
  fetchImpl,
}: {
  repositoryId: string;
  projectId: string;
  subscriptions: AdoServiceHookSubscription[];
  webhookUrl: string;
  secretToken: string;
  token: string;
  organizationApiBaseUrl: string;
  fetchImpl?: typeof fetch;
}): Promise<'created' | 'updated'> {
  const statuses: ('created' | 'updated')[] = [];

  for (const descriptor of ADO_PULL_REQUEST_SERVICE_HOOK_EVENTS) {
    const descriptorWebhookUrl = buildAdoServiceHookWebhookUrl({
      webhookUrl,
      queryParams: descriptor.webhookQueryParams,
    });
    statuses.push(
      await upsertAdoServiceHookSubscription({
        repositoryId,
        projectId,
        eventType: descriptor.eventType,
        publisherInputs: descriptor.publisherInputs,
        webhookUrl: descriptorWebhookUrl,
        secretToken,
        subscriptions,
        token,
        organizationApiBaseUrl,
        fetchImpl,
      }),
    );
  }

  return statuses.includes('created') ? 'created' : 'updated';
}

async function ensureAdoProjectServiceHooks({
  projectId,
  subscriptions,
  webhookUrl,
  secretToken,
  token,
  organizationApiBaseUrl,
  fetchImpl,
}: {
  projectId: string;
  subscriptions: AdoServiceHookSubscription[];
  webhookUrl: string;
  secretToken: string;
  token: string;
  organizationApiBaseUrl: string;
  fetchImpl?: typeof fetch;
}): Promise<'created' | 'updated'> {
  const statuses: ('created' | 'updated')[] = [];

  for (const descriptor of ADO_PROJECT_SERVICE_HOOK_EVENTS) {
    statuses.push(
      await upsertAdoServiceHookSubscription({
        projectId,
        eventType: descriptor.eventType,
        publisherInputs: descriptor.publisherInputs,
        resourceVersion: descriptor.resourceVersion,
        webhookUrl,
        secretToken,
        subscriptions,
        token,
        organizationApiBaseUrl,
        fetchImpl,
      }),
    );
  }

  return statuses.includes('created') ? 'created' : 'updated';
}

export async function ensureAdoServiceHooksForRepositories({
  repositories,
  webhookUrl,
  secretToken,
  token,
  organization,
  baseUrl,
  fetchImpl,
}: {
  repositories: {
    repositoryFullName: string;
    repositoryId: string;
    projectId: string;
  }[];
  webhookUrl: string;
  secretToken: string;
  token?: string;
  organization?: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}): Promise<AdoServiceHookEnsureResult[]> {
  const adoToken = token ?? (await resolveAdoToken());

  if (!adoToken?.trim()) {
    throw new Error(
      'ADO_TOKEN is required to configure Azure DevOps service hooks.',
    );
  }

  const resolvedOrganization = organization ?? (await resolveAdoOrganization());

  if (!resolvedOrganization?.trim()) {
    throw new Error(
      'ADO_ORGANIZATION is required to configure Azure DevOps service hooks.',
    );
  }

  const organizationApiBaseUrl = buildAdoOrganizationApiBaseUrl({
    baseUrl:
      baseUrl === undefined
        ? await resolveAdoBaseUrl()
        : normalizeBaseUrl(baseUrl),
    organization: resolvedOrganization,
  });
  const subscriptions = await listAdoServiceHookSubscriptions({
    organizationApiBaseUrl,
    token: adoToken,
    fetchImpl,
  });
  const results: AdoServiceHookEnsureResult[] = [];

  for (
    let index = 0;
    index < repositories.length;
    index += ADO_SERVICE_HOOK_ENSURE_CONCURRENCY
  ) {
    const chunk = repositories.slice(
      index,
      index + ADO_SERVICE_HOOK_ENSURE_CONCURRENCY,
    );

    results.push(
      ...(await Promise.all(
        chunk.map(
          async (repository): Promise<AdoServiceHookEnsureResult> =>
            ensureAdoRepositoryServiceHooks({
              repositoryId: repository.repositoryId,
              projectId: repository.projectId,
              subscriptions,
              webhookUrl,
              secretToken,
              token: adoToken,
              organizationApiBaseUrl,
              fetchImpl,
            })
              .then((status) => ({
                repositoryFullName: repository.repositoryFullName,
                status,
              }))
              .catch((error: unknown) => ({
                repositoryFullName: repository.repositoryFullName,
                status: 'failed' as const,
                error: error instanceof Error ? error.message : String(error),
              })),
        ),
      )),
    );
  }

  // Project-scoped hooks (work-item @mentions, build completion) are ensured
  // once per project after the per-repository PR hooks so multi-repo projects
  // only create a single subscription per event. Re-list subscriptions so IDs
  // removed by a preceding unmapped-repo cleanup (or concurrent DELETE) are
  // not PUT-updated as if they still exist.
  const projectSubscriptions = await listAdoServiceHookSubscriptions({
    organizationApiBaseUrl,
    token: adoToken,
    fetchImpl,
  });
  const projectIds = [
    ...new Set(repositories.map((repository) => repository.projectId)),
  ];
  for (const projectId of projectIds) {
    try {
      await ensureAdoProjectServiceHooks({
        projectId,
        subscriptions: projectSubscriptions,
        webhookUrl,
        secretToken,
        token: adoToken,
        organizationApiBaseUrl,
        fetchImpl,
      });
    } catch (error) {
      // Reflect open failures on every repository result from the same project
      // so webhook setup reports something went wrong instead of silent miss.
      const message = error instanceof Error ? error.message : String(error);
      for (const result of results) {
        const repository = repositories.find(
          (entry) => entry.repositoryFullName === result.repositoryFullName,
        );
        if (repository?.projectId === projectId && result.status !== 'failed') {
          result.status = 'failed';
          result.error = message;
        }
      }
    }
  }

  return results;
}

function hostFromBaseUrl(baseUrl: string): string {
  return new URL(normalizeBaseUrl(baseUrl)).host;
}

function buildAdoRepositoryFullName(
  organization: string,
  repository: AdoRepository,
): string {
  return [
    normalizeOrganization(organization),
    repository.project.name,
    repository.name,
  ].join('/');
}

function normalizeAdoDefaultBranch(branch: string | null | undefined): string {
  return stripAdoGitRef(branch) || 'main';
}

export function stripAdoGitRef(refName: string | null | undefined): string {
  return (refName ?? '').trim().replace(/^refs\/heads\//, '');
}

/**
 * Host of the deployment-configured Azure DevOps base URL (e.g. dev.azure.com).
 * Manual Run matches repository `host` against this so the deployment
 * credential is not pointed at an unrelated collection host.
 */
export async function resolveAdoInstanceHost(): Promise<string> {
  return hostFromBaseUrl(await resolveAdoBaseUrl()).toLowerCase();
}

export type AdoServiceHookRemoveResult = {
  repositoryFullName: string;
  status: 'removed' | 'not_found' | 'failed';
  error?: string;
};

function isRoomoteAdoSubscriptionUrl(
  subscriptionUrl: string | undefined,
  webhookUrl: string,
): boolean {
  if (!subscriptionUrl) {
    return false;
  }

  return (
    subscriptionUrl === webhookUrl ||
    subscriptionUrl.startsWith(`${webhookUrl}?`)
  );
}

/**
 * Removes the Roomote pull-request service-hook subscriptions (matched by
 * the deployment webhook URL, including notificationType query variants)
 * from each repository. Sync uses this to keep service hooks scoped to
 * repositories the deployment actually uses: synced repositories without an
 * environment mapping get their Roomote subscriptions removed instead of
 * refreshed. Failures are collected per repository instead of failing the
 * whole batch.
 *
 * Project-scoped hooks (`workitem.commented`, `build.complete`) are removed
 * only when the project is not in `retainProjectIds` (projects that still have
 * mapped repositories). Deleting them while a mapped repo remains leaves
 * ensure unable to update the deleted subscription id from a stale list.
 */
export async function removeAdoServiceHooksForRepositories({
  repositories,
  webhookUrl,
  retainProjectIds,
  token,
  organization,
  baseUrl,
  fetchImpl = fetch,
}: {
  repositories: {
    repositoryFullName: string;
    repositoryId: string;
    projectId: string;
  }[];
  webhookUrl: string;
  /**
   * Project IDs that still have environment-mapped repositories. Project-
   * scoped hooks (work-item comments, build completion) for these projects
   * are left in place so a partial unmap does not tear down intake.
   */
  retainProjectIds?: Iterable<string>;
  token?: string;
  organization?: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}): Promise<AdoServiceHookRemoveResult[]> {
  const adoToken = token ?? (await resolveAdoToken());

  if (!adoToken?.trim()) {
    throw new Error(
      'ADO_TOKEN is required to configure Azure DevOps service hooks.',
    );
  }

  const resolvedOrganization = organization ?? (await resolveAdoOrganization());

  if (!resolvedOrganization?.trim()) {
    throw new Error(
      'ADO_ORGANIZATION is required to configure Azure DevOps service hooks.',
    );
  }

  const organizationApiBaseUrl = buildAdoOrganizationApiBaseUrl({
    baseUrl:
      baseUrl === undefined
        ? await resolveAdoBaseUrl()
        : normalizeBaseUrl(baseUrl),
    organization: resolvedOrganization,
  });
  const subscriptions = await listAdoServiceHookSubscriptions({
    organizationApiBaseUrl,
    token: adoToken,
    fetchImpl,
  });

  const results: AdoServiceHookRemoveResult[] = [];

  const projectEventTypes = new Set(
    ADO_PROJECT_SERVICE_HOOK_EVENTS.map((event) => event.eventType),
  );
  const retainedProjects = new Set(
    [...(retainProjectIds ?? [])].filter((id) => Boolean(id?.trim())),
  );
  // Track project-level hooks deleted once so multi-repo same-project
  // removals don't 404 on a second delete of the same subscription.
  const deletedProjectSubscriptionIds = new Set<string>();

  for (const repository of repositories) {
    const matching = subscriptions.filter(
      (subscription) =>
        subscription.publisherId === ADO_SERVICE_HOOK_PUBLISHER_ID &&
        subscription.consumerId === ADO_SERVICE_HOOK_CONSUMER_ID &&
        subscription.consumerActionId === ADO_SERVICE_HOOK_CONSUMER_ACTION_ID &&
        (subscription.publisherInputs?.repository ?? '') ===
          repository.repositoryId &&
        (subscription.publisherInputs?.projectId ?? '') ===
          repository.projectId &&
        isRoomoteAdoSubscriptionUrl(
          subscription.consumerInputs?.url,
          webhookUrl,
        ),
    );

    // Only tear down project-scoped hooks when no mapped repository remains
    // for this project (caller omits projectId from retainProjectIds).
    const projectMatching = retainedProjects.has(repository.projectId)
      ? []
      : subscriptions.filter(
          (subscription) =>
            subscription.publisherId === ADO_SERVICE_HOOK_PUBLISHER_ID &&
            subscription.consumerId === ADO_SERVICE_HOOK_CONSUMER_ID &&
            subscription.consumerActionId ===
              ADO_SERVICE_HOOK_CONSUMER_ACTION_ID &&
            projectEventTypes.has(subscription.eventType) &&
            !(subscription.publisherInputs?.repository ?? '') &&
            (subscription.publisherInputs?.projectId ?? '') ===
              repository.projectId &&
            isRoomoteAdoSubscriptionUrl(
              subscription.consumerInputs?.url,
              webhookUrl,
            ) &&
            !deletedProjectSubscriptionIds.has(subscription.id),
        );

    if (matching.length === 0 && projectMatching.length === 0) {
      results.push({
        repositoryFullName: repository.repositoryFullName,
        status: 'not_found',
      });
      continue;
    }

    try {
      for (const subscription of [...matching, ...projectMatching]) {
        const response = await fetchImpl(
          buildAdoApiUrl(
            organizationApiBaseUrl,
            `/_apis/hooks/subscriptions/${encodeURIComponent(subscription.id)}`,
            { 'api-version': ADO_API_VERSION },
          ),
          {
            method: 'DELETE',
            headers: {
              Accept: 'application/json',
              Authorization: buildAdoBasicAuthHeader(adoToken),
            },
          },
        );

        if (![200, 204, 404].includes(response.status)) {
          throw new Error(
            `Azure DevOps API request failed: ${response.status} ${response.statusText}`,
          );
        }

        if (projectEventTypes.has(subscription.eventType)) {
          deletedProjectSubscriptionIds.add(subscription.id);
        }
      }

      results.push({
        repositoryFullName: repository.repositoryFullName,
        status: 'removed',
      });
    } catch (error) {
      results.push({
        repositoryFullName: repository.repositoryFullName,
        status: 'failed',
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return results;
}

export function buildAdoRepositoryValues({
  repository,
  linkedByUserId,
  organization,
  baseUrl = DEFAULT_ADO_BASE_URL,
}: {
  repository: AdoRepository;
  linkedByUserId: string;
  organization: string;
  baseUrl?: string;
}): AdoRepositoryValues {
  const fullName = buildAdoRepositoryFullName(organization, repository);
  const host = hostFromBaseUrl(baseUrl);
  // Azure DevOps remoteUrl embeds the organization as URL userinfo
  // (https://org@dev.azure.com/...), which breaks the worker's git
  // insteadOf proxy rewrite, so store the clone URL without it.
  const cloneUrl = stripCloneUrlUserInfo(
    repository.remoteUrl ??
      buildRepositoryCloneUrl({
        provider: ADO_PROVIDER,
        host,
        repositoryFullName: fullName,
      }),
  );

  return {
    sourceControlProvider: ADO_PROVIDER,
    installationId: null,
    userId: null,
    githubRepoId: null,
    externalRepoId: repository.id,
    host,
    name: repository.name,
    fullName,
    description: repository.project.description ?? null,
    private: repository.project.visibility !== 'public',
    defaultBranch: normalizeAdoDefaultBranch(repository.defaultBranch),
    cloneUrl,
    htmlUrl: repository.webUrl ?? cloneUrl.replace(/\.git$/, ''),
    permissions: {
      projectId: repository.project.id,
      projectState: repository.project.state,
      projectVisibility: repository.project.visibility,
    },
    isActive: true,
    linkedByUserId,
  };
}

export async function syncAdoRepositories({
  userId,
  token,
  organization,
  baseUrl,
  repositories: adoRepositories,
  fetchImpl,
}: {
  userId: string;
  token?: string;
  organization?: string;
  baseUrl?: string;
  repositories?: AdoRepository[];
  fetchImpl?: typeof fetch;
}) {
  const resolvedOrganization = organization ?? (await resolveAdoOrganization());

  if (!resolvedOrganization?.trim()) {
    throw new Error(
      'ADO_ORGANIZATION is required to sync Azure DevOps repositories.',
    );
  }

  const resolvedBaseUrl =
    baseUrl === undefined
      ? await resolveAdoBaseUrl()
      : normalizeBaseUrl(baseUrl);
  const existingIds = (
    await db
      .select({ id: repositories.id })
      .from(repositories)
      .where(
        and(
          eq(repositories.sourceControlProvider, ADO_PROVIDER),
          eq(repositories.isActive, true),
        ),
      )
  ).map((repository) => repository.id);

  const repositoriesToSync =
    adoRepositories ??
    (await listAdoRepositories({
      token,
      organization: resolvedOrganization,
      baseUrl: resolvedBaseUrl,
      fetchImpl,
    }));

  const syncedRepositories = [];

  for (const repository of repositoriesToSync) {
    const values = buildAdoRepositoryValues({
      repository,
      linkedByUserId: userId,
      organization: resolvedOrganization,
      baseUrl: resolvedBaseUrl,
    });

    const findExistingRepository = () =>
      db.query.repositories.findFirst({
        where: and(
          eq(repositories.sourceControlProvider, ADO_PROVIDER),
          eq(repositories.externalRepoId, values.externalRepoId),
        ),
      });

    const existingRepository = await findExistingRepository();

    if (existingRepository) {
      await db
        .update(repositories)
        .set({ ...values, updatedAt: new Date() })
        .where(eq(repositories.id, existingRepository.id));
    } else {
      await db.insert(repositories).values(values);
    }

    const syncedRepository = await findExistingRepository();

    if (syncedRepository) {
      syncedRepositories.push(syncedRepository);
    }
  }

  const syncedIds = new Set(
    syncedRepositories.map((repository) => repository.id),
  );
  const missingIds = existingIds.filter((id) => !syncedIds.has(id));

  if (missingIds.length > 0) {
    await db
      .update(repositories)
      .set({ isActive: false, updatedAt: new Date() })
      .where(inArray(repositories.id, missingIds));
  }

  return {
    success: true as const,
    repositories: syncedRepositories,
  };
}

function normalizeRepositorySelection(repositoryNames: string[]): string[] {
  return [...new Set(repositoryNames.filter(Boolean))];
}

async function resolveAdoRepositoryNamesForTaskRun(
  taskRun: TaskRun,
): Promise<string[] | null> {
  const filterForAdo = (repositoryNames: string[]) => {
    return filterRepositoryNamesForSourceControlProvider(
      taskRun.payload,
      repositoryNames,
      ADO_PROVIDER,
    );
  };

  if (taskRun.payload.environmentId) {
    const environment = await db.query.environments.findFirst({
      where: eq(environments.id, taskRun.payload.environmentId),
    });

    if (!environment) {
      throw new Error(
        `Environment not found for task run ${taskRun.id}: ${taskRun.payload.environmentId}`,
      );
    }

    return filterForAdo(
      normalizeRepositorySelection(
        environment.config.repositories.map(
          (repository) => repository.repository,
        ),
      ),
    );
  }

  if (Array.isArray(taskRun.payload.selectedRepositories)) {
    const selectedRepositories = normalizeRepositorySelection(
      taskRun.payload.selectedRepositories,
    );

    if (selectedRepositories.length > 0) {
      return filterForAdo(selectedRepositories);
    }
  }

  if (taskRun.payload.repo && taskRun.payload.repo !== ALL_REPOSITORIES) {
    return [taskRun.payload.repo];
  }

  return null;
}

async function resolveAdoRepositoryRowsForTaskRun(taskRun: TaskRun) {
  const repositoryNames = await resolveAdoRepositoryNamesForTaskRun(taskRun);
  const queryConditions = [
    eq(repositories.sourceControlProvider, ADO_PROVIDER),
    eq(repositories.isActive, true),
  ];

  if (repositoryNames !== null) {
    queryConditions.push(inArray(repositories.fullName, repositoryNames));
  }

  const repositoryRows = await db.query.repositories.findMany({
    where: and(...queryConditions),
    columns: {
      fullName: true,
      cloneUrl: true,
    },
  });

  if (repositoryNames === null) {
    if (repositoryRows.length === 0) {
      throw new Error(
        `No synced Azure DevOps repositories found for task run ${taskRun.id}.`,
      );
    }

    return repositoryRows;
  }

  const repositoryByName = new Map(
    repositoryRows.map((repository) => [repository.fullName, repository]),
  );
  const missingRepositories = repositoryNames.filter(
    (repositoryName) => !repositoryByName.has(repositoryName),
  );

  if (missingRepositories.length > 0) {
    throw new Error(
      `Selected Azure DevOps repositories not found for task run ${taskRun.id}: ${missingRepositories.join(', ')}`,
    );
  }

  return repositoryNames.map((repositoryName) => {
    const repository = repositoryByName.get(repositoryName);

    if (!repository?.cloneUrl?.trim()) {
      throw new Error(
        `Azure DevOps repository ${repositoryName} is missing a clone URL.`,
      );
    }

    return repository;
  });
}

function normalizeCredentialRepositoryPath(rawPath: string): string {
  let start = 0;
  while (start < rawPath.length && rawPath.charCodeAt(start) === 47 /* / */) {
    start += 1;
  }

  let path = start === 0 ? rawPath : rawPath.slice(start);
  if (path.endsWith('.git')) {
    path = path.slice(0, -4);
  }
  return stripTrailingSlashes(path);
}

function stripBasePathPrefix(rawPath: string, originBaseUrl: string): string {
  const basePath = stripTrailingSlashes(new URL(originBaseUrl).pathname);

  if (!basePath || basePath === '/') {
    return rawPath;
  }

  if (rawPath === basePath) {
    return '/';
  }

  if (rawPath.startsWith(`${basePath}/`)) {
    return rawPath.slice(basePath.length);
  }

  return rawPath;
}

function buildAdoGitCredential({
  cloneUrl,
  fallbackRepositoryFullName,
  fallbackHost,
  username,
  token,
  originBaseUrl,
}: {
  cloneUrl: string;
  fallbackRepositoryFullName: string;
  fallbackHost: string;
  username: string;
  token: string;
  originBaseUrl: string;
}): AdoRepositoryCredential {
  try {
    const url = new URL(cloneUrl);
    const repositoryPath = stripBasePathPrefix(url.pathname, originBaseUrl);

    return {
      host: url.host,
      repositoryFullName: normalizeCredentialRepositoryPath(repositoryPath),
      username,
      token,
      authScheme: isEntraAccessToken(token) ? 'bearer' : 'basic',
      originBaseUrl,
    };
  } catch {
    return {
      host: fallbackHost,
      repositoryFullName: fallbackRepositoryFullName,
      username,
      token,
      authScheme: isEntraAccessToken(token) ? 'bearer' : 'basic',
      originBaseUrl,
    };
  }
}

export async function createTaskRunAdoCredentials(
  taskRun: TaskRun,
  options?: {
    token?: string;
    baseUrl?: string;
    username?: string;
  },
): Promise<{
  credentials: AdoRepositoryCredential[];
  expiresAt: Date | null;
}> {
  const resolvedToken = options?.token
    ? { token: options.token, expiresAt: null }
    : await resolveAdoTokenWithMetadata();
  const deploymentToken = resolvedToken?.token;

  if (!deploymentToken?.trim()) {
    throw new Error(
      'ADO_TOKEN is required for Azure DevOps source control jobs.',
    );
  }

  const baseUrl =
    options?.baseUrl === undefined
      ? await resolveAdoBaseUrl()
      : normalizeBaseUrl(options.baseUrl);
  const username =
    options?.username ??
    (await resolveAdoUsername()) ??
    DEFAULT_ADO_GIT_USERNAME;
  const host = hostFromBaseUrl(baseUrl);
  const repositoriesList = await resolveAdoRepositoryRowsForTaskRun(taskRun);

  return {
    credentials: repositoriesList.map((repository) =>
      buildAdoGitCredential({
        cloneUrl: repository.cloneUrl,
        fallbackRepositoryFullName: repository.fullName,
        fallbackHost: host,
        username,
        token: deploymentToken,
        originBaseUrl: baseUrl,
      }),
    ),
    expiresAt: resolvedToken?.expiresAt ?? null,
  };
}
