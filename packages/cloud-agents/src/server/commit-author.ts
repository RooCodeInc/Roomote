import {
  type CommitAuthorKind,
  getUserDisplayName,
  PRODUCT_NAME,
} from '@roomote/types';
import {
  type DatabaseOrTransaction,
  desc,
  eq,
  githubUserMappings,
  users,
} from '@roomote/db/server';

/**
 * Git author identity used for commits made on behalf of a task.
 */
export type ResolvedGitAuthor = {
  name: string;
  email: string;
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
  githubLogin: string | null;
  prAssigneeLogin: string | null;
  gitAuthor: ResolvedGitAuthor;
};

export const DEFAULT_ROOMOTE_COMMIT_AUTHOR: ResolvedTaskCommitAuthor = {
  kind: 'roomote',
  displayName: PRODUCT_NAME,
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
        email: true,
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
      normalizeNullableString(getUserDisplayName(user)) ??
      githubLogin ??
      PRODUCT_NAME;

    if (!githubIdentity.githubLogin || !githubIdentity.githubUserId) {
      return {
        kind: 'user',
        displayName,
        githubLogin,
        prAssigneeLogin,
        gitAuthor: ROOMOTE_GIT_AUTHOR,
      };
    }

    return {
      kind: 'user',
      displayName,
      githubLogin,
      prAssigneeLogin,
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

    if (!githubLogin || !externalId) {
      return {
        kind: 'external',
        displayName,
        githubLogin,
        prAssigneeLogin,
        gitAuthor: ROOMOTE_GIT_AUTHOR,
      };
    }

    return {
      kind: 'external',
      displayName,
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
