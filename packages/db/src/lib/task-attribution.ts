import {
  type CloudTask,
  type EffectiveAuthorKind,
  type EffectiveAuthorReason,
  type EffectivePrOwnerKind,
  type EffectivePrOwnerReason,
  type TaskAttributionKind,
  type TaskAttributionSourceKind,
  CloudTaskType,
  PRODUCT_NAME,
  getCommunicationProviderFromTaskPayload,
  getUserDisplayName,
} from '@roomote/types';
import { and, desc, eq } from 'drizzle-orm';

import type { DatabaseOrTransaction } from '../db';
import {
  githubUserMappings,
  mcpConnections,
  slackUserMappings,
  users,
} from '../schema';

type MinimalUser = {
  id?: string | null;
  name?: string | null;
  email?: string | null;
};

export type TaskAttributionSnapshot = {
  attributionKind: TaskAttributionKind | null;
  attributedUserId: string | null;
  attributionSourceKind: TaskAttributionSourceKind | null;
  attributionSourceDisplayName: string | null;
  attributionSourceExternalId: string | null;
  attributedGithubLogin: string | null;
  attributedGithubUserId?: number | null;
  effectiveAuthorKind?: EffectiveAuthorKind | null;
  effectiveAuthorUserId?: string | null;
  effectiveAuthorDisplayName?: string | null;
  effectiveAuthorGithubLogin?: string | null;
  effectiveAuthorGithubUserId?: number | null;
  effectiveAuthorReason?: EffectiveAuthorReason | null;
  effectiveAuthorRuleId?: string | null;
  effectivePrOwnerKind?: EffectivePrOwnerKind | null;
  effectivePrOwnerUserId?: string | null;
  effectivePrOwnerDisplayName?: string | null;
  effectivePrOwnerGithubLogin?: string | null;
  effectivePrOwnerReason?: EffectivePrOwnerReason | null;
  effectivePrOwnerRuleId?: string | null;
};

export type ResolvedTaskAttributionDisplay = {
  authorKind: EffectiveAuthorKind;
  kind: TaskAttributionKind;
  sourceKind: TaskAttributionSourceKind;
  githubDisplay: string | null;
  productDisplay: string;
  analyticsDisplay: string;
  assigneeGithubLogin: string | null;
};

export type ResolvedGitAuthor = {
  name: string;
  email: string;
};

function normalizeNullableString(
  value: string | null | undefined,
): string | null {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

function normalizeNullableNumber(
  value: number | null | undefined,
): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function getSourceLabel(sourceKind: TaskAttributionSourceKind): string {
  switch (sourceKind) {
    case 'slack':
      return 'Slack';
    case 'github':
      return 'GitHub';
    case 'gitlab':
      return 'GitLab';
    case 'gitea':
      return 'Gitea';
    case 'ado':
      return 'Azure DevOps';
    case 'linear':
      return 'Linear';
    case 'teams':
      return 'Microsoft Teams';
    case 'telegram':
      return 'Telegram';
    case 'web':
      return 'Web';
    case 'automation':
      return 'automation';
    case 'system':
    default:
      return PRODUCT_NAME;
  }
}

function getUnlinkedDisplayLabel(
  snapshot: TaskAttributionSnapshot,
  sourceKind: TaskAttributionSourceKind,
): string {
  const sourceDisplayName = normalizeNullableString(
    snapshot.attributionSourceDisplayName,
  );
  if (sourceDisplayName) {
    return sourceDisplayName;
  }

  const sourceExternalId = normalizeNullableString(
    snapshot.attributionSourceExternalId,
  );
  if (sourceExternalId) {
    return sourceExternalId;
  }

  return `Unlinked ${getSourceLabel(sourceKind)} user`;
}

function buildEffectiveHumanDisplay(snapshot: TaskAttributionSnapshot): string {
  return (
    normalizeNullableString(snapshot.effectiveAuthorDisplayName) ||
    normalizeNullableString(snapshot.attributionSourceDisplayName) ||
    normalizeNullableString(snapshot.attributionSourceExternalId) ||
    `Unlinked ${getSourceLabel(snapshot.attributionSourceKind ?? 'system')} user`
  );
}

export function resolveTaskAttributionDisplay(
  snapshot: TaskAttributionSnapshot,
  options: {
    attributedUser?: MinimalUser | null;
  } = {},
): ResolvedTaskAttributionDisplay {
  const effectiveAuthorKind = snapshot.effectiveAuthorKind ?? null;
  const effectivePrOwnerKind = snapshot.effectivePrOwnerKind ?? null;
  const effectivePrOwnerGithubLogin = normalizeNullableString(
    snapshot.effectivePrOwnerGithubLogin,
  );
  const effectiveAuthorGithubLogin = normalizeNullableString(
    snapshot.effectiveAuthorGithubLogin,
  );

  if (effectiveAuthorKind === 'roomote') {
    return {
      authorKind: 'roomote',
      kind: 'automatic',
      sourceKind: snapshot.attributionSourceKind ?? 'system',
      githubDisplay: null,
      productDisplay: PRODUCT_NAME,
      analyticsDisplay: PRODUCT_NAME,
      assigneeGithubLogin:
        effectivePrOwnerKind === 'specific_user'
          ? effectivePrOwnerGithubLogin
          : effectivePrOwnerKind === 'none'
            ? null
            : null,
    };
  }

  if (effectiveAuthorKind === 'human') {
    const humanDisplay = buildEffectiveHumanDisplay(snapshot);
    const assigneeGithubLogin =
      effectivePrOwnerKind === 'specific_user'
        ? effectivePrOwnerGithubLogin
        : effectivePrOwnerKind === 'none'
          ? null
          : effectiveAuthorGithubLogin;

    return {
      authorKind: 'human',
      kind: snapshot.effectiveAuthorUserId ? 'matched_user' : 'unlinked_user',
      sourceKind: snapshot.attributionSourceKind ?? 'system',
      githubDisplay: humanDisplay,
      productDisplay: humanDisplay,
      analyticsDisplay: humanDisplay,
      assigneeGithubLogin,
    };
  }

  const kind = snapshot.attributionKind ?? 'automatic';
  const sourceKind = snapshot.attributionSourceKind ?? 'system';
  const matchedDisplay =
    getUserDisplayName(options.attributedUser) ||
    normalizeNullableString(snapshot.attributionSourceDisplayName) ||
    PRODUCT_NAME;
  const unlinkedDisplay = getUnlinkedDisplayLabel(snapshot, sourceKind);

  if (kind === 'matched_user') {
    return {
      authorKind: 'human',
      kind,
      sourceKind,
      githubDisplay: matchedDisplay,
      productDisplay: matchedDisplay,
      analyticsDisplay: matchedDisplay,
      assigneeGithubLogin: normalizeNullableString(
        snapshot.attributedGithubLogin,
      ),
    };
  }

  if (kind === 'unlinked_user') {
    return {
      authorKind: 'human',
      kind,
      sourceKind,
      githubDisplay: null,
      productDisplay: unlinkedDisplay,
      analyticsDisplay: unlinkedDisplay,
      assigneeGithubLogin: null,
    };
  }

  return {
    authorKind: 'roomote',
    kind: 'automatic',
    sourceKind,
    githubDisplay: null,
    productDisplay: PRODUCT_NAME,
    analyticsDisplay: PRODUCT_NAME,
    assigneeGithubLogin: null,
  };
}

async function findMatchedSlackUserId(
  tx: DatabaseOrTransaction,
  params: {
    slackUserId: string | null;
    slackTeamId: string | null;
  },
): Promise<string | null> {
  if (!params.slackUserId || !params.slackTeamId) {
    return null;
  }

  const [mapping] = await tx
    .select({ userId: slackUserMappings.userId })
    .from(slackUserMappings)
    .where(
      and(
        eq(slackUserMappings.slackUserId, params.slackUserId),
        eq(slackUserMappings.slackTeamId, params.slackTeamId),
      ),
    )
    .limit(1);

  return mapping?.userId ?? null;
}

async function findMatchedLinearUserId(
  tx: DatabaseOrTransaction,
  params: {
    linearUserId: string | null;
    linearOrganizationId: string | null;
  },
): Promise<string | null> {
  if (!params.linearUserId || !params.linearOrganizationId) {
    return null;
  }

  const connections = await tx
    .select({
      userId: mcpConnections.userId,
      authConfig: mcpConnections.authConfig,
    })
    .from(mcpConnections)
    .where(
      and(
        eq(mcpConnections.mcpId, 'linear'),
        eq(mcpConnections.connectionRole, 'linear_user_link'),
      ),
    );

  const connection = connections.find((candidate) => {
    const config = candidate.authConfig;
    if (!config || typeof config !== 'object') {
      return false;
    }

    return (
      'linearOrganizationId' in config &&
      'linearUserId' in config &&
      config.linearOrganizationId === params.linearOrganizationId &&
      config.linearUserId === params.linearUserId
    );
  });

  return connection?.userId ?? null;
}

async function findMatchedGitHubUserId(
  tx: DatabaseOrTransaction,
  params: {
    githubUserId?: number | null;
    githubLogin?: string | null;
  },
): Promise<string | null> {
  const githubLogin = normalizeNullableString(params.githubLogin);
  const githubUserId = params.githubUserId ?? null;

  if (!githubLogin && !githubUserId) {
    return null;
  }

  const conditions = [];

  if (githubUserId !== null) {
    conditions.push(eq(githubUserMappings.githubUserId, githubUserId));
  } else if (githubLogin) {
    conditions.push(eq(githubUserMappings.githubLogin, githubLogin));
  }

  const [mapping] = await tx
    .select({ userId: githubUserMappings.userId })
    .from(githubUserMappings)
    .where(and(...conditions))
    .orderBy(desc(githubUserMappings.updatedAt))
    .limit(1);

  return mapping?.userId ?? null;
}

export async function findLatestGithubIdentityForUser(
  tx: DatabaseOrTransaction,
  userId: string | null,
): Promise<{ githubLogin: string | null; githubUserId: number | null }> {
  if (!userId) {
    return { githubLogin: null, githubUserId: null };
  }

  const mapping = await tx.query.githubUserMappings.findFirst({
    where: eq(githubUserMappings.userId, userId),
    orderBy: [desc(githubUserMappings.updatedAt)],
    columns: {
      githubLogin: true,
      githubUserId: true,
    },
  });

  return {
    githubLogin: normalizeNullableString(mapping?.githubLogin),
    githubUserId: mapping?.githubUserId ?? null,
  };
}

function getSlackSourceDisplayName(
  task: Extract<CloudTask, { type: CloudTaskType.SlackAppMention }>,
): string | null {
  const exactMessage = task.payload.threadMessages?.find((message) => {
    if (message.ts !== task.payload.ts) {
      return false;
    }

    const sourceSlackUserId = normalizeNullableString(task.payload.user);
    return !sourceSlackUserId || message.user === sourceSlackUserId;
  });

  if (exactMessage?.username) {
    return exactMessage.username.trim();
  }

  const sourceSlackUserId = normalizeNullableString(task.payload.user);
  const latestMatchingMessage = task.payload.threadMessages
    ?.slice()
    .reverse()
    .find((message) => {
      return sourceSlackUserId ? message.user === sourceSlackUserId : false;
    });

  return normalizeNullableString(latestMatchingMessage?.username);
}

function getTaskGithubIdentity(task: CloudTask): {
  githubLogin: string | null;
  githubUserId: number | null;
} {
  return {
    githubLogin:
      'githubLogin' in task ? normalizeNullableString(task.githubLogin) : null,
    githubUserId:
      'githubUserId' in task && typeof task.githubUserId === 'number'
        ? task.githubUserId
        : null,
  };
}

function getSnapshotResumeAttributionUserId(
  task: Extract<CloudTask, { type: CloudTaskType.SnapshotResume }>,
): string | null {
  return (
    normalizeNullableString(task.payload.resumePromptUserId) ||
    normalizeNullableString(task.userId)
  );
}

function inferSourceKind(task: CloudTask): TaskAttributionSourceKind {
  const { githubLogin, githubUserId } = getTaskGithubIdentity(task);
  const communicationProvider = getCommunicationProviderFromTaskPayload(
    task.payload,
  );

  if (task.type === CloudTaskType.SnapshotResume) {
    if (communicationProvider) {
      return communicationProvider;
    }

    if (
      task.linearSessionId ||
      task.linearOrganizationId ||
      task.linearIssueId
    ) {
      return 'linear';
    }

    if (
      task.slackThreadTs ||
      task.payload.channel ||
      task.payload.slackChannel ||
      task.payload.thread_ts ||
      task.payload.slackOriginMessageTs
    ) {
      return 'slack';
    }

    if (getSnapshotResumeAttributionUserId(task)) {
      return 'web';
    }

    return 'automation';
  }

  if (task.type === CloudTaskType.SlackAppMention) {
    return 'slack';
  }

  if (task.type === CloudTaskType.LinearAgentSession) {
    return 'linear';
  }

  if (task.type.startsWith('github.') || githubLogin || githubUserId) {
    return 'github';
  }

  if (communicationProvider) {
    return communicationProvider;
  }

  if (task.type === CloudTaskType.StandardTask) {
    return 'web';
  }

  if (
    task.type === CloudTaskType.SuggestedTasks ||
    task.type === CloudTaskType.McpRecommendations ||
    task.type === CloudTaskType.LegacyOnboardingSuggestions ||
    task.type === CloudTaskType.SnapshotEnvironment
  ) {
    return 'automation';
  }

  return 'system';
}

function inferSourceExternalId(task: CloudTask): string | null {
  if (task.type === CloudTaskType.SlackAppMention) {
    return normalizeNullableString(task.payload.user);
  }

  if (task.type === CloudTaskType.LinearAgentSession) {
    return normalizeNullableString(task.payload.userId);
  }

  const { githubLogin, githubUserId } = getTaskGithubIdentity(task);
  if (githubLogin) {
    return githubLogin;
  }

  if (githubUserId) {
    return String(githubUserId);
  }

  return null;
}

function inferSourceDisplayName(task: CloudTask): string | null {
  if (task.type === CloudTaskType.SlackAppMention) {
    return getSlackSourceDisplayName(task);
  }

  if (task.type === CloudTaskType.LinearAgentSession) {
    return normalizeNullableString(task.payload.username);
  }

  return getTaskGithubIdentity(task).githubLogin;
}

export async function buildTaskAttributionSnapshot(
  tx: DatabaseOrTransaction,
  task: CloudTask,
): Promise<TaskAttributionSnapshot> {
  const sourceKind = inferSourceKind(task);
  const sourceDisplayName = inferSourceDisplayName(task);
  const sourceExternalId = inferSourceExternalId(task);
  const githubSourceIdentity =
    sourceKind === 'github'
      ? getTaskGithubIdentity(task)
      : { githubLogin: null, githubUserId: null };

  let attributedUserId: string | null = null;

  if (
    task.type === CloudTaskType.SnapshotResume &&
    getSnapshotResumeAttributionUserId(task) &&
    (sourceKind === 'slack' ||
      sourceKind === 'linear' ||
      sourceKind === 'teams' ||
      sourceKind === 'telegram' ||
      sourceKind === 'web')
  ) {
    attributedUserId = getSnapshotResumeAttributionUserId(task);
  } else if (
    sourceKind === 'slack' &&
    task.type === CloudTaskType.SlackAppMention
  ) {
    attributedUserId = await findMatchedSlackUserId(tx, {
      slackUserId: normalizeNullableString(task.payload.user),
      slackTeamId: normalizeNullableString(task.payload.teamId),
    });
  } else if (
    sourceKind === 'linear' &&
    task.type === CloudTaskType.LinearAgentSession
  ) {
    attributedUserId = await findMatchedLinearUserId(tx, {
      linearUserId: normalizeNullableString(task.payload.userId),
      linearOrganizationId: normalizeNullableString(
        task.payload.organizationId,
      ),
    });
  } else if (sourceKind === 'github') {
    const { githubLogin, githubUserId } = getTaskGithubIdentity(task);
    attributedUserId = await findMatchedGitHubUserId(tx, {
      githubUserId,
      githubLogin,
    });
  } else if (
    (sourceKind === 'web' ||
      sourceKind === 'teams' ||
      sourceKind === 'telegram') &&
    task.userId
  ) {
    attributedUserId = task.userId;
  }

  if (attributedUserId) {
    const githubIdentity = await findLatestGithubIdentityForUser(
      tx,
      attributedUserId,
    );

    return {
      attributionKind: 'matched_user',
      attributedUserId,
      attributionSourceKind: sourceKind,
      attributionSourceDisplayName: sourceDisplayName,
      attributionSourceExternalId: sourceExternalId,
      attributedGithubLogin: githubIdentity.githubLogin,
      attributedGithubUserId:
        githubIdentity.githubUserId ?? githubSourceIdentity.githubUserId,
    };
  }

  if (
    (sourceKind === 'slack' ||
      sourceKind === 'github' ||
      sourceKind === 'gitlab' ||
      sourceKind === 'gitea' ||
      sourceKind === 'ado' ||
      sourceKind === 'teams' ||
      sourceKind === 'telegram' ||
      sourceKind === 'linear') &&
    sourceExternalId
  ) {
    return {
      attributionKind: 'unlinked_user',
      attributedUserId: null,
      attributionSourceKind: sourceKind,
      attributionSourceDisplayName: sourceDisplayName,
      attributionSourceExternalId: sourceExternalId,
      attributedGithubLogin:
        sourceKind === 'github' ? githubSourceIdentity.githubLogin : null,
      attributedGithubUserId:
        sourceKind === 'github' ? githubSourceIdentity.githubUserId : null,
    };
  }

  return {
    attributionKind: 'automatic',
    attributedUserId: null,
    attributionSourceKind: sourceKind,
    attributionSourceDisplayName: sourceDisplayName,
    attributionSourceExternalId: sourceExternalId,
    attributedGithubLogin: null,
    attributedGithubUserId: null,
  };
}

export async function resolveTaskAttribution(
  tx: DatabaseOrTransaction,
  snapshot: TaskAttributionSnapshot,
): Promise<
  ResolvedTaskAttributionDisplay & {
    gitAuthor: ResolvedGitAuthor;
  }
> {
  const attributedUser = snapshot.attributedUserId
    ? await tx.query.users.findFirst({
        where: eq(users.id, snapshot.attributedUserId),
        columns: {
          id: true,
          name: true,
          email: true,
        },
      })
    : null;

  const display = resolveTaskAttributionDisplay(snapshot, { attributedUser });

  if (snapshot.effectiveAuthorKind === 'roomote') {
    return {
      ...display,
      gitAuthor: {
        name: PRODUCT_NAME,
        email: 'roomote@roomote.dev',
      },
    };
  }

  if (snapshot.effectiveAuthorKind === 'human') {
    const githubLogin =
      normalizeNullableString(snapshot.effectiveAuthorGithubLogin) ??
      normalizeNullableString(snapshot.attributedGithubLogin);
    const githubUserId =
      normalizeNullableNumber(snapshot.effectiveAuthorGithubUserId) ??
      normalizeNullableNumber(snapshot.attributedGithubUserId) ??
      null;
    const gitAuthorName =
      normalizeNullableString(snapshot.effectiveAuthorDisplayName) ??
      display.githubDisplay ??
      PRODUCT_NAME;

    if (!githubLogin || !githubUserId) {
      return {
        ...display,
        gitAuthor: {
          name: PRODUCT_NAME,
          email: 'roomote@roomote.dev',
        },
      };
    }

    return {
      ...display,
      gitAuthor: {
        name: gitAuthorName,
        email: `${githubUserId}+${githubLogin}@users.noreply.github.com`,
      },
    };
  }

  if (display.kind !== 'matched_user' || !snapshot.attributedUserId) {
    return {
      ...display,
      gitAuthor: {
        name: PRODUCT_NAME,
        email: 'roomote@roomote.dev',
      },
    };
  }

  const githubIdentity = await findLatestGithubIdentityForUser(
    tx,
    snapshot.attributedUserId,
  );
  const gitAuthorName =
    getUserDisplayName(attributedUser) ||
    githubIdentity.githubLogin ||
    PRODUCT_NAME;

  if (!githubIdentity.githubLogin || !githubIdentity.githubUserId) {
    return {
      ...display,
      gitAuthor: {
        name: PRODUCT_NAME,
        email: 'roomote@roomote.dev',
      },
    };
  }

  return {
    ...display,
    gitAuthor: {
      name: gitAuthorName,
      email: `${githubIdentity.githubUserId}+${githubIdentity.githubLogin}@users.noreply.github.com`,
    },
  };
}

export function buildUnlinkedAttributionPhrase(
  sourceKind: TaskAttributionSourceKind,
  sourceDisplayName: string | null | undefined,
): string {
  const sourceLabel = getSourceLabel(sourceKind);
  const displayName = normalizeNullableString(sourceDisplayName);

  if (!displayName) {
    return `an unlinked ${sourceLabel} user`;
  }

  return `an unlinked ${sourceLabel} user (${displayName})`;
}
