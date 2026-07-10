import { z } from 'zod';

import {
  ALL_REPOSITORIES,
  buildRepositoryCloneUrl,
  stripCloneUrlUserInfo,
  type SourceControlProvider,
} from '@roomote/types';
import {
  type TaskRun,
  db,
  environments,
  repositories,
  and,
  eq,
  inArray,
  resolveDeploymentEnvVar,
} from '@roomote/db/server';

const ADO_PROVIDER = 'ado' satisfies SourceControlProvider;
const DEFAULT_ADO_BASE_URL = 'https://dev.azure.com';
const ADO_API_VERSION = '7.1';
const ADO_TOKEN_VALIDATION_TIMEOUT_MS = 10_000;
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
] as const;

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

function normalizeBaseUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, '');

  if (!trimmed) {
    throw new Error('ADO_BASE_URL cannot be empty.');
  }

  return new URL(trimmed).toString().replace(/\/+$/, '');
}

function normalizeOrganization(organization: string): string {
  const trimmed = organization.trim().replace(/^\/+|\/+$/g, '');

  if (!trimmed) {
    throw new Error(
      'ADO_ORGANIZATION is required to sync Azure DevOps repositories.',
    );
  }

  return trimmed;
}

export async function resolveAdoToken(): Promise<string | null> {
  return resolveDeploymentEnvVar('ADO_TOKEN');
}

export async function resolveAdoOrganization(): Promise<string | null> {
  const organization = await resolveDeploymentEnvVar('ADO_ORGANIZATION');
  return organization ? normalizeOrganization(organization) : null;
}

export async function resolveAdoBaseUrl(): Promise<string> {
  const baseUrl = await resolveDeploymentEnvVar('ADO_BASE_URL');
  return normalizeBaseUrl(baseUrl ?? DEFAULT_ADO_BASE_URL);
}

export async function resolveAdoUsername(): Promise<string | null> {
  return resolveDeploymentEnvVar('ADO_USERNAME');
}

export function buildAdoOrganizationApiBaseUrl({
  baseUrl,
  organization,
}: {
  baseUrl: string;
  organization: string;
}): string {
  return new URL(
    `${encodeURIComponent(normalizeOrganization(organization))}/`,
    `${normalizeBaseUrl(baseUrl)}/`,
  )
    .toString()
    .replace(/\/+$/, '');
}

function buildAdoApiUrl(
  organizationApiBaseUrl: string,
  path: string,
  params: Record<string, string | number | boolean>,
): string {
  const url = new URL(
    path.replace(/^\//, ''),
    `${organizationApiBaseUrl.replace(/\/$/, '')}/`,
  );

  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, String(value));
  }

  return url.toString();
}

function buildAdoBasicAuthHeader(token: string): string {
  return `Basic ${Buffer.from(`:${token}`, 'utf8').toString('base64')}`;
}

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
        Authorization: buildAdoBasicAuthHeader(token),
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    },
  );

  if (![200, 201].includes(response.status)) {
    throw new Error(
      `Azure DevOps API request failed: ${response.status} ${response.statusText}`,
    );
  }

  return {
    data: schema.parse(await response.json()),
    response,
  };
}

function parseAdoRepositoryFullName(repositoryFullName: string): {
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

async function resolveAdoOrganizationApiBaseUrl({
  organization,
  baseUrl,
  organizationApiBaseUrl,
}: {
  organization?: string;
  baseUrl?: string;
  organizationApiBaseUrl?: string;
} = {}): Promise<string | null> {
  if (organizationApiBaseUrl?.trim()) {
    return organizationApiBaseUrl.replace(/\/+$/, '');
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
    params: { 'api-version': ADO_API_VERSION },
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

export type AdoTokenValidationResult =
  | { status: 'valid'; displayName: string }
  | { status: 'invalid'; error: string }
  | { status: 'unknown'; error: string };

export async function validateAdoToken({
  token,
  organization,
  baseUrl,
  fetchImpl = fetch,
  timeoutMs = ADO_TOKEN_VALIDATION_TIMEOUT_MS,
}: {
  token: string;
  organization: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<AdoTokenValidationResult> {
  try {
    const organizationApiBaseUrl = buildAdoOrganizationApiBaseUrl({
      baseUrl:
        baseUrl === undefined
          ? await resolveAdoBaseUrl()
          : normalizeBaseUrl(baseUrl),
      organization,
    });
    const response = await fetchImpl(
      buildAdoApiUrl(organizationApiBaseUrl, '/_apis/connectionData', {
        'api-version': ADO_API_VERSION,
      }),
      {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          Authorization: buildAdoBasicAuthHeader(token),
        },
        signal: AbortSignal.timeout(timeoutMs),
      },
    );

    // Azure DevOps answers rejected PATs with a 203 sign-in page instead of
    // a 401, so treat that status as a definitive rejection too.
    if ([203, 401, 403].includes(response.status)) {
      return {
        status: 'invalid',
        error:
          'Azure DevOps rejected the token. Confirm the PAT is active, belongs to the organization, and has Code read access.',
      };
    }

    if (response.status !== 200) {
      return {
        status: 'unknown',
        error: `Could not verify the Azure DevOps token: ${response.status} ${response.statusText}`,
      };
    }

    const { authenticatedUser } = adoConnectionDataSchema.parse(
      await response.json(),
    );

    return {
      status: 'valid',
      displayName:
        authenticatedUser.providerDisplayName ??
        authenticatedUser.displayName ??
        authenticatedUser.uniqueName ??
        authenticatedUser.id,
    };
  } catch (error) {
    return {
      status: 'unknown',
      error: `Could not verify the Azure DevOps token: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
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
  webhookUrl,
  secretToken,
}: {
  repositoryId: string;
  projectId: string;
  eventType: string;
  publisherInputs?: Record<string, string>;
  webhookUrl: string;
  secretToken: string;
}) {
  return {
    publisherId: ADO_SERVICE_HOOK_PUBLISHER_ID,
    eventType,
    resourceVersion: '1.0',
    consumerId: ADO_SERVICE_HOOK_CONSUMER_ID,
    consumerActionId: ADO_SERVICE_HOOK_CONSUMER_ACTION_ID,
    publisherInputs: {
      projectId,
      repository: repositoryId,
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
  repositoryId: string;
  projectId: string;
  publisherInputs?: Record<string, string>;
}): boolean {
  const existingInputs = subscription.publisherInputs ?? {};

  if (
    existingInputs.projectId !== projectId ||
    existingInputs.repository !== repositoryId
  ) {
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
  repositoryId: string;
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
    const body = buildAdoServiceHookSubscriptionBody({
      repositoryId,
      projectId,
      eventType: descriptor.eventType,
      publisherInputs: descriptor.publisherInputs,
      webhookUrl: descriptorWebhookUrl,
      secretToken,
    });
    const existingSubscription = findAdoServiceHookSubscription({
      subscriptions,
      eventType: descriptor.eventType,
      repositoryId,
      projectId,
      publisherInputs: descriptor.publisherInputs,
      webhookUrl: descriptorWebhookUrl,
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
      statuses.push('created');
      continue;
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
    statuses.push('updated');
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
  const trimmed = branch?.trim();

  if (!trimmed) {
    return 'main';
  }

  return trimmed.replace(/^refs\/heads\//, '');
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
 */
export async function removeAdoServiceHooksForRepositories({
  repositories,
  webhookUrl,
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

    if (matching.length === 0) {
      results.push({
        repositoryFullName: repository.repositoryFullName,
        status: 'not_found',
      });
      continue;
    }

    try {
      for (const subscription of matching) {
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
  if (taskRun.payload.environmentId) {
    const environment = await db.query.environments.findFirst({
      where: eq(environments.id, taskRun.payload.environmentId),
    });

    if (!environment) {
      throw new Error(
        `Environment not found for task run ${taskRun.id}: ${taskRun.payload.environmentId}`,
      );
    }

    return normalizeRepositorySelection(
      environment.config.repositories.map(
        (repository) => repository.repository,
      ),
    );
  }

  if (Array.isArray(taskRun.payload.selectedRepositories)) {
    const selectedRepositories = normalizeRepositorySelection(
      taskRun.payload.selectedRepositories,
    );

    if (selectedRepositories.length > 0) {
      return selectedRepositories;
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
  return rawPath
    .replace(/^\/+/, '')
    .replace(/\.git$/, '')
    .replace(/\/+$/, '');
}

function stripBasePathPrefix(rawPath: string, originBaseUrl: string): string {
  const basePath = new URL(originBaseUrl).pathname.replace(/\/+$/, '');

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
      originBaseUrl,
    };
  } catch {
    return {
      host: fallbackHost,
      repositoryFullName: fallbackRepositoryFullName,
      username,
      token,
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
}> {
  const deploymentToken = options?.token ?? (await resolveAdoToken());

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
  };
}
