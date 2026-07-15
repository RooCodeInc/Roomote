import {
  db,
  repositories,
  environments,
  environmentRepositoryMappings,
  deploymentSettings,
  eq,
} from '@roomote/db/server';

import type {
  RoutingContext,
  RoutableEnvironment,
  SlackRoutingSource,
  TeamsRoutingSource,
  TelegramRoutingSource,
  DiscordRoutingSource,
  LinearRoutingSource,
  GitHubRoutingSource,
} from './types';

const DEFAULT_DEPLOYMENT_ID = 'default';

async function fetchDeploymentTaskModelSettings() {
  const deployment = await db.query.deploymentSettings.findFirst({
    where: eq(deploymentSettings.id, DEFAULT_DEPLOYMENT_ID),
    columns: {
      taskModelSettings: true,
    },
  });

  return deployment?.taskModelSettings ?? null;
}

/**
 * Parameters for building a Slack routing context.
 */
export interface SlackContextParams {
  userId?: string;
  routingModel?: string;
  taskDescription: string;
  channelName?: string;
  threadMessages?: Array<{ text: string; user: string }>;
  images?: string[];
  videoDescriptions?: string[];
  apiBaseUrl?: string;
}

/**
 * Parameters for building a Teams routing context.
 */
export interface TeamsContextParams {
  userId?: string;
  routingModel?: string;
  taskDescription: string;
  teamName?: string;
  channelName?: string;
  threadMessages?: Array<{ text: string; user: string }>;
  images?: string[];
  apiBaseUrl?: string;
}

/**
 * Parameters for building a Telegram routing context.
 */
export interface TelegramContextParams {
  userId?: string;
  routingModel?: string;
  taskDescription: string;
  chatName?: string;
  threadMessages?: Array<{ text: string; user: string }>;
  images?: string[];
  apiBaseUrl?: string;
}

export interface DiscordContextParams {
  userId?: string;
  routingModel?: string;
  taskDescription: string;
  guildName?: string;
  channelName?: string;
  threadMessages?: Array<{ text: string; user: string }>;
  images?: string[];
  apiBaseUrl?: string;
}

/**
 * Parameters for building a Linear routing context.
 */
export interface LinearContextParams {
  userId?: string;
  routingModel?: string;
  taskDescription: string;
  issueIdentifier: string;
  issueTitle: string;
  issueDescription?: string;
  projectName?: string;
  teamName?: string;
  guidance?: { system?: string; instructions?: string };
  previousComments?: Array<{ body: string; username?: string }>;
  apiBaseUrl?: string;
}

/**
 * Parameters for building a GitHub routing context.
 */
export interface GitHubContextParams {
  taskDescription: string;
  repository: string;
  headRefName?: string;
  prAuthorLogin?: string;
  issueOrPrTitle?: string;
  issueOrPrBody?: string;
  commentBody?: string;
}

/**
 * Builds a routing context for a Slack request.
 */
export async function buildSlackRoutingContext(
  params: SlackContextParams,
): Promise<RoutingContext> {
  const [envs, taskModelSettings] = await Promise.all([
    getAvailableEnvironments(),
    fetchDeploymentTaskModelSettings(),
  ]);

  const source: SlackRoutingSource = {
    type: 'slack',
    channelName: params.channelName,
    threadMessages: params.threadMessages,
    images: params.images,
    videoDescriptions: params.videoDescriptions,
  };

  return {
    routingModel: params.routingModel,
    taskDescription: params.taskDescription,
    source,
    availableEnvironments: envs,
    taskModelSettings,
    ...(params.userId
      ? {
          routingActor: {
            userId: params.userId,
            apiBaseUrl: params.apiBaseUrl,
          },
        }
      : {}),
  };
}

/**
 * Builds a routing context for a Teams request.
 */
export async function buildTeamsRoutingContext(
  params: TeamsContextParams,
): Promise<RoutingContext> {
  const [envs, taskModelSettings] = await Promise.all([
    getAvailableEnvironments(),
    fetchDeploymentTaskModelSettings(),
  ]);

  const source: TeamsRoutingSource = {
    type: 'teams',
    teamName: params.teamName,
    channelName: params.channelName,
    threadMessages: params.threadMessages,
    images: params.images,
  };

  return {
    routingModel: params.routingModel,
    taskDescription: params.taskDescription,
    source,
    availableEnvironments: envs,
    taskModelSettings,
    ...(params.userId
      ? {
          routingActor: {
            userId: params.userId,
            apiBaseUrl: params.apiBaseUrl,
          },
        }
      : {}),
  };
}

/**
 * Builds a routing context for a Telegram request.
 */
export async function buildTelegramRoutingContext(
  params: TelegramContextParams,
): Promise<RoutingContext> {
  const [envs, taskModelSettings] = await Promise.all([
    getAvailableEnvironments(),
    fetchDeploymentTaskModelSettings(),
  ]);

  const source: TelegramRoutingSource = {
    type: 'telegram',
    chatName: params.chatName,
    threadMessages: params.threadMessages,
    images: params.images,
  };

  return {
    routingModel: params.routingModel,
    taskDescription: params.taskDescription,
    source,
    availableEnvironments: envs,
    taskModelSettings,
    ...(params.userId
      ? {
          routingActor: {
            userId: params.userId,
            apiBaseUrl: params.apiBaseUrl,
          },
        }
      : {}),
  };
}

/** Builds a routing context for a Discord request. */
export async function buildDiscordRoutingContext(
  params: DiscordContextParams,
): Promise<RoutingContext> {
  const [envs, taskModelSettings] = await Promise.all([
    getAvailableEnvironments(),
    fetchDeploymentTaskModelSettings(),
  ]);
  const source: DiscordRoutingSource = {
    type: 'discord',
    guildName: params.guildName,
    channelName: params.channelName,
    threadMessages: params.threadMessages,
    images: params.images,
  };
  return {
    routingModel: params.routingModel,
    taskDescription: params.taskDescription,
    source,
    availableEnvironments: envs,
    taskModelSettings,
    ...(params.userId
      ? {
          routingActor: {
            userId: params.userId,
            apiBaseUrl: params.apiBaseUrl,
          },
        }
      : {}),
  };
}

/**
 * Builds a routing context for a Linear request.
 */
export async function buildLinearRoutingContext(
  params: LinearContextParams,
): Promise<RoutingContext> {
  const [envs, taskModelSettings] = await Promise.all([
    getAvailableEnvironments(),
    fetchDeploymentTaskModelSettings(),
  ]);

  const source: LinearRoutingSource = {
    type: 'linear',
    issueIdentifier: params.issueIdentifier,
    issueTitle: params.issueTitle,
    issueDescription: params.issueDescription,
    projectName: params.projectName,
    teamName: params.teamName,
    guidance: params.guidance,
    previousComments: params.previousComments,
  };

  return {
    routingModel: params.routingModel,
    taskDescription: params.taskDescription,
    source,
    availableEnvironments: envs,
    taskModelSettings,
    ...(params.userId
      ? {
          routingActor: {
            userId: params.userId,
            apiBaseUrl: params.apiBaseUrl,
          },
        }
      : {}),
  };
}

/**
 * Builds a routing context for a GitHub request that is already scoped to a
 * specific repository and candidate GitHub-capable agents.
 */
export function buildGitHubRoutingContext(
  params: GitHubContextParams,
): RoutingContext {
  const source: GitHubRoutingSource = {
    type: 'github',
    repository: params.repository,
    headRefName: params.headRefName,
    prAuthorLogin: params.prAuthorLogin,
    issueOrPrTitle: params.issueOrPrTitle,
    issueOrPrBody: params.issueOrPrBody,
    commentBody: params.commentBody,
  };

  return {
    taskDescription: params.taskDescription,
    source,
    availableEnvironments: [],
  };
}

/**
 * Gets all environments for this deployment with their repository names.
 */
export async function getAvailableEnvironments(): Promise<
  RoutableEnvironment[]
> {
  const envs = await db
    .select({
      id: environments.id,
      name: environments.name,
      description: environments.description,
    })
    .from(environments)
    .where(eq(environments.isEval, false));

  // Get repository names for each environment.
  const result: RoutableEnvironment[] = [];

  for (const env of envs) {
    const mappings = await db
      .select({
        repoName: repositories.fullName,
      })
      .from(environmentRepositoryMappings)
      .innerJoin(
        repositories,
        eq(environmentRepositoryMappings.repositoryId, repositories.id),
      )
      .where(eq(environmentRepositoryMappings.environmentId, env.id));

    result.push({
      id: env.id,
      name: env.name,
      description: env.description ?? undefined,
      repositoryNames: mappings.map((m) => m.repoName),
    });
  }

  return result;
}
