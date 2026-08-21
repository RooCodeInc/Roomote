import {
  type CommitAuthorKind,
  type SourceControlProvider,
  type TaskInitiator,
  PRODUCT_NAME,
} from '@roomote/types';
import {
  type DatabaseOrTransaction,
  and,
  desc,
  eq,
  githubUserMappings,
  sourceControlUserMappings,
  tasks,
  users,
} from '@roomote/db/server';

/**
 * Git author identity used for commits made on behalf of a task.
 */
export type ResolvedGitAuthor = {
  name: string;
  email: string;
};

/**
 * The persisted 5-column commit-author block stamped onto tasks at enqueue.
 */
export type CommitAuthorSelection = {
  commitAuthorKind: CommitAuthorKind;
  commitAuthorUserId: string | null;
  commitAuthorLogin: string | null;
  commitAuthorExternalId: string | null;
  prAssigneeLogin: string | null;
};

export type MatchedHumanActor = {
  userId: string;
  githubLogin: string | null;
  githubUserId: number | null;
};

export type EvaluateCommitAuthorInput = {
  initiator: TaskInitiator;
  /**
   * The linked user the initiator resolves to (initiator.userId or
   * initiator.matchedUserId), enriched with their latest GitHub identity.
   */
  matchedHumanActor: MatchedHumanActor | null;
  /**
   * Raw GitHub identity supplied by the launch for unlinked humans (e.g. the
   * PR author on conflict-resolution or webhook-review launches).
   */
  externalGithubIdentity?: {
    githubLogin?: string | null;
    githubUserId?: number | null;
  };
};

export const ROOMOTE_GIT_AUTHOR: ResolvedGitAuthor = {
  name: PRODUCT_NAME,
  email: 'roomote@roomote.dev',
};

/**
 * Display + git identity resolved from the persisted commit-author block on a
 * tasks row (commitAuthorKind/commitAuthorUserId/commitAuthorLogin/
 * commitAuthorExternalId/prAssigneeLogin).
 */
export type ResolvedTaskCommitAuthor = {
  kind: CommitAuthorKind;
  /** Human-readable display name; PRODUCT_NAME for roomote authorship. */
  displayName: string;
  /** Source-control handle safe to publish, including its leading `@`. */
  publicDisplayName: string | null;
  githubLogin: string | null;
  prAssigneeLogin: string | null;
  gitAuthor: ResolvedGitAuthor;
};

export const DEFAULT_ROOMOTE_COMMIT_AUTHOR: ResolvedTaskCommitAuthor = {
  kind: 'roomote',
  displayName: PRODUCT_NAME,
  publicDisplayName: null,
  githubLogin: null,
  prAssigneeLogin: null,
  gitAuthor: ROOMOTE_GIT_AUTHOR,
};

/**
 * Subset of the tasks row needed to resolve the effective commit author.
 */
export type TaskCommitAuthorColumns = {
  commitAuthorKind: CommitAuthorKind | null;
  commitAuthorUserId: string | null;
  commitAuthorLogin: string | null;
  commitAuthorExternalId: string | null;
  prAssigneeLogin: string | null;
  actorDisplayName: string | null;
};

function normalizeNullableString(
  value: string | null | undefined,
): string | null {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

function normalizeOptionalNumber(
  value: number | null | undefined,
): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * Evaluates the persisted commit-author block for a fresh task launch.
 *
 * Defaults:
 * - automation-initiated -> 'roomote'
 * - user-initiated with a linked user -> 'user' (+ their latest GitHub
 *   identity when available)
 * - user-initiated unlinked -> 'external' (with GitHub login + numeric id
 *   when the launch supplied one)
 *
 * The PR assignee defaults to the effective author's GitHub login.
 */
export function evaluateCommitAuthor(
  input: EvaluateCommitAuthorInput,
): CommitAuthorSelection {
  if (input.initiator.kind === 'automation') {
    return {
      commitAuthorKind: 'roomote',
      commitAuthorUserId: null,
      commitAuthorLogin: null,
      commitAuthorExternalId: null,
      prAssigneeLogin: null,
    };
  }

  if (input.matchedHumanActor?.userId) {
    const githubLogin = normalizeNullableString(
      input.matchedHumanActor.githubLogin,
    );
    const githubUserId = normalizeOptionalNumber(
      input.matchedHumanActor.githubUserId,
    );

    return {
      commitAuthorKind: 'user',
      commitAuthorUserId: input.matchedHumanActor.userId,
      commitAuthorLogin: githubLogin,
      commitAuthorExternalId:
        githubUserId !== null ? String(githubUserId) : null,
      prAssigneeLogin: githubLogin,
    };
  }

  // Unlinked human. Preserve any GitHub identity so their noreply commits
  // survive; without one the git author falls back to Roomote at read time
  // while the task still displays the external actor.
  const githubLogin = normalizeNullableString(
    input.externalGithubIdentity?.githubLogin,
  );
  const githubUserId = normalizeOptionalNumber(
    input.externalGithubIdentity?.githubUserId,
  );

  return {
    commitAuthorKind: 'external',
    commitAuthorUserId: null,
    commitAuthorLogin: githubLogin,
    commitAuthorExternalId: githubUserId !== null ? String(githubUserId) : null,
    prAssigneeLogin: githubLogin,
  };
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

/**
 * Resolves the tasks commit-author block into display + git identity:
 * - 'roomote' (or unevaluated) -> Roomote / roomote@roomote.dev
 * - 'user' -> users row + latest GitHub mapping; noreply email when the
 *   mapping has both a login and a numeric id, Roomote fallback otherwise.
 * - 'external' -> `{externalId}+{login}@users.noreply.github.com`; Roomote
 *   fallback when the GitHub identity is incomplete.
 */
export async function resolveTaskCommitAuthor(
  tx: DatabaseOrTransaction,
  task: TaskCommitAuthorColumns,
): Promise<ResolvedTaskCommitAuthor> {
  const prAssigneeLogin = normalizeNullableString(task.prAssigneeLogin);

  if (task.commitAuthorKind === 'user' && task.commitAuthorUserId) {
    const user = await tx.query.users.findFirst({
      where: eq(users.id, task.commitAuthorUserId),
      columns: {
        id: true,
        name: true,
      },
    });

    const githubIdentity = await findLatestGithubIdentityForUser(
      tx,
      task.commitAuthorUserId,
    );
    const githubLogin =
      githubIdentity.githubLogin ??
      normalizeNullableString(task.commitAuthorLogin);
    const displayName =
      normalizeNullableString(user?.name) ?? githubLogin ?? PRODUCT_NAME;
    const publicDisplayName = githubLogin ? `@${githubLogin}` : null;

    if (!githubIdentity.githubLogin || !githubIdentity.githubUserId) {
      return {
        kind: 'user',
        displayName,
        publicDisplayName,
        githubLogin,
        prAssigneeLogin: null,
        gitAuthor: ROOMOTE_GIT_AUTHOR,
      };
    }

    return {
      kind: 'user',
      displayName,
      publicDisplayName,
      githubLogin,
      prAssigneeLogin: githubIdentity.githubLogin,
      gitAuthor: {
        name: displayName,
        email: `${githubIdentity.githubUserId}+${githubIdentity.githubLogin}@users.noreply.github.com`,
      },
    };
  }

  if (task.commitAuthorKind === 'external') {
    const githubLogin = normalizeNullableString(task.commitAuthorLogin);
    const externalId = normalizeNullableString(task.commitAuthorExternalId);
    const displayName =
      normalizeNullableString(task.actorDisplayName) ??
      githubLogin ??
      PRODUCT_NAME;
    const publicDisplayName = githubLogin ? `@${githubLogin}` : null;

    if (!githubLogin || !externalId) {
      return {
        kind: 'external',
        displayName,
        publicDisplayName,
        githubLogin,
        prAssigneeLogin,
        gitAuthor: ROOMOTE_GIT_AUTHOR,
      };
    }

    return {
      kind: 'external',
      displayName,
      publicDisplayName,
      githubLogin,
      prAssigneeLogin,
      gitAuthor: {
        name: displayName,
        email: `${externalId}+${githubLogin}@users.noreply.github.com`,
      },
    };
  }

  return {
    ...DEFAULT_ROOMOTE_COMMIT_AUTHOR,
    prAssigneeLogin,
  };
}

/** Use the provider noreply identity only when its public handle is available. */
export function resolvePublicGitAuthor(
  attribution: ResolvedTaskCommitAuthor,
): ResolvedGitAuthor {
  return attribution.publicDisplayName &&
    attribution.gitAuthor.email !== ROOMOTE_GIT_AUTHOR.email
    ? { ...attribution.gitAuthor, name: attribution.publicDisplayName }
    : ROOMOTE_GIT_AUTHOR;
}

/**
 * Resolves attribution for a live run. A linked participant owns their turns;
 * all ownerless or unlinked runs use the Roomote app identity.
 */
export async function resolveRunCommitAuthor(
  tx: DatabaseOrTransaction,
  run: { taskId: string; actingUserId: string | null },
  sourceControl?: {
    provider: SourceControlProvider;
    host?: string;
  },
): Promise<ResolvedTaskCommitAuthor> {
  if (run.actingUserId) {
    if (sourceControl && sourceControl.provider !== 'github') {
      const user = await tx.query.users.findFirst({
        where: eq(users.id, run.actingUserId),
        columns: { id: true, name: true },
      });
      if (!user) {
        return DEFAULT_ROOMOTE_COMMIT_AUTHOR;
      }

      const mapping = sourceControl.host
        ? await tx.query.sourceControlUserMappings.findFirst({
            where: and(
              eq(sourceControlUserMappings.userId, run.actingUserId),
              eq(
                sourceControlUserMappings.sourceControlProvider,
                sourceControl.provider,
              ),
              eq(sourceControlUserMappings.host, sourceControl.host),
            ),
            orderBy: [desc(sourceControlUserMappings.updatedAt)],
            columns: {
              externalAccountId: true,
              username: true,
              displayName: true,
            },
          })
        : null;
      const username = normalizeNullableString(mapping?.username);
      const displayName =
        normalizeNullableString(user.name) ??
        normalizeNullableString(mapping?.displayName) ??
        username ??
        PRODUCT_NAME;
      const commitEmail =
        sourceControl.provider === 'gitlab' &&
        sourceControl.host === 'gitlab.com' &&
        mapping?.externalAccountId &&
        username
          ? `${mapping.externalAccountId}-${username}@users.noreply.gitlab.com`
          : ROOMOTE_GIT_AUTHOR.email;

      return {
        kind: 'user',
        displayName,
        publicDisplayName: username ? `@${username}` : null,
        githubLogin: null,
        prAssigneeLogin: sourceControl.provider === 'gitea' ? username : null,
        gitAuthor: {
          name: displayName,
          email: commitEmail,
        },
      };
    }

    const [user, githubIdentity] = await Promise.all([
      tx.query.users.findFirst({
        where: eq(users.id, run.actingUserId),
        columns: { id: true },
      }),
      findLatestGithubIdentityForUser(tx, run.actingUserId),
    ]);
    if (!user || !githubIdentity.githubLogin || !githubIdentity.githubUserId) {
      return DEFAULT_ROOMOTE_COMMIT_AUTHOR;
    }

    return resolveTaskCommitAuthor(tx, {
      commitAuthorKind: 'user',
      commitAuthorUserId: run.actingUserId,
      commitAuthorLogin: null,
      commitAuthorExternalId: null,
      prAssigneeLogin: null,
      actorDisplayName: null,
    });
  }

  return DEFAULT_ROOMOTE_COMMIT_AUTHOR;
}

/** Resolves immutable launch attribution for audit and legacy PR cleanup. */
export async function resolveLaunchTaskCommitAuthor(
  tx: DatabaseOrTransaction,
  taskId: string,
): Promise<ResolvedTaskCommitAuthor> {
  const task = await tx.query.tasks.findFirst({
    where: eq(tasks.id, taskId),
    columns: {
      commitAuthorKind: true,
      commitAuthorUserId: true,
      commitAuthorLogin: true,
      commitAuthorExternalId: true,
      prAssigneeLogin: true,
      actorDisplayName: true,
    },
  });

  if (!task) {
    throw new Error(
      `Task ${taskId} not found while resolving launch attribution.`,
    );
  }

  return resolveTaskCommitAuthor(tx, task);
}
