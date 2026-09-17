import { randomUUID } from 'node:crypto';

import {
  and,
  db,
  desc,
  eq,
  githubUserMappings,
  isNull,
  lt,
  or,
  resolveDeploymentEnvVar,
} from '@roomote/db/server';
import { decrypt } from '@roomote/db/encryption';

const GITHUB_USER_TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000;
const GITHUB_USER_TOKEN_REFRESH_TIMEOUT_MS = 15_000;
const GITHUB_USER_TOKEN_REFRESH_CLAIM_GRACE_MS = 5_000;
const GITHUB_USER_TOKEN_REFRESH_POLL_MS = 100;

const pendingRefreshes = new Map<string, Promise<string | null>>();

export class GitHubUserTokenError extends Error {
  constructor(
    message: string,
    public readonly reauthorizationRequired: boolean,
  ) {
    super(message);
    this.name = 'GitHubUserTokenError';
  }
}

export async function resolveGitHubUserAccessToken(
  userId: string,
  options?: { fetchImpl?: typeof fetch; now?: number; timeoutMs?: number },
): Promise<string | null> {
  const pendingRefresh = pendingRefreshes.get(userId);
  if (pendingRefresh) return pendingRefresh;

  const resolution = resolveGitHubUserAccessTokenOnce(userId, options);
  pendingRefreshes.set(userId, resolution);
  try {
    return await resolution;
  } finally {
    if (pendingRefreshes.get(userId) === resolution) {
      pendingRefreshes.delete(userId);
    }
  }
}

async function resolveGitHubUserAccessTokenOnce(
  userId: string,
  options?: { fetchImpl?: typeof fetch; now?: number; timeoutMs?: number },
): Promise<string | null> {
  const now = options?.now ?? Date.now();
  const refreshTimeoutMs =
    options?.timeoutMs ?? GITHUB_USER_TOKEN_REFRESH_TIMEOUT_MS;
  const claimTtlMs =
    Math.max(refreshTimeoutMs, GITHUB_USER_TOKEN_REFRESH_TIMEOUT_MS) +
    GITHUB_USER_TOKEN_REFRESH_CLAIM_GRACE_MS;

  while (true) {
    const mapping = await db.query.githubUserMappings.findFirst({
      where: eq(githubUserMappings.userId, userId),
      orderBy: [desc(githubUserMappings.updatedAt)],
      columns: {
        id: true,
        accessToken: true,
        refreshToken: true,
        tokenExpiresAt: true,
      },
    });

    if (!mapping?.accessToken) return null;
    const accessToken = decrypt(mapping.accessToken);
    if (
      !mapping.tokenExpiresAt ||
      mapping.tokenExpiresAt.getTime() >
        now + GITHUB_USER_TOKEN_REFRESH_BUFFER_MS
    ) {
      return accessToken;
    }
    const claimId = randomUUID();
    const claimedAt = new Date();
    const claimed = await db
      .update(githubUserMappings)
      .set({
        tokenRefreshClaim: claimId,
        tokenRefreshClaimedAt: claimedAt,
      })
      .where(
        and(
          eq(githubUserMappings.id, mapping.id),
          eq(githubUserMappings.userId, userId),
          eq(githubUserMappings.tokenExpiresAt, mapping.tokenExpiresAt),
          or(
            isNull(githubUserMappings.tokenRefreshClaim),
            isNull(githubUserMappings.tokenRefreshClaimedAt),
            lt(
              githubUserMappings.tokenRefreshClaimedAt,
              new Date(claimedAt.getTime() - claimTtlMs),
            ),
          ),
        ),
      )
      .returning({ id: githubUserMappings.id });

    if (claimed.length === 0) {
      await new Promise((resolve) =>
        setTimeout(resolve, GITHUB_USER_TOKEN_REFRESH_POLL_MS),
      );
      continue;
    }

    try {
      const refreshToken = mapping.refreshToken
        ? decrypt(mapping.refreshToken)
        : null;
      const [clientId, clientSecret] = await Promise.all([
        resolveDeploymentEnvVar('R_GITHUB_CLIENT_ID'),
        resolveDeploymentEnvVar('R_GITHUB_CLIENT_SECRET'),
      ]);
      if (!refreshToken || !clientId?.trim() || !clientSecret?.trim()) {
        throw new GitHubUserTokenError(
          'GitHub account authorization has expired. Reconnect GitHub under Settings > Linked Accounts.',
          true,
        );
      }

      let response: Response;
      try {
        response = await (options?.fetchImpl ?? fetch)(
          'https://github.com/login/oauth/access_token',
          {
            method: 'POST',
            redirect: 'error',
            headers: {
              Accept: 'application/json',
              'Content-Type': 'application/x-www-form-urlencoded',
            },
            body: new URLSearchParams({
              client_id: clientId.trim(),
              client_secret: clientSecret.trim(),
              grant_type: 'refresh_token',
              refresh_token: refreshToken,
            }),
            signal: AbortSignal.timeout(refreshTimeoutMs),
          },
        );
      } catch {
        throw new GitHubUserTokenError(
          'GitHub account authorization could not be refreshed. Try again, or reconnect GitHub under Settings > Linked Accounts.',
          false,
        );
      }

      if (!response.ok) {
        const retryable = response.status >= 500 || response.status === 429;
        throw new GitHubUserTokenError(
          retryable
            ? 'GitHub account authorization could not be refreshed. Try again, or reconnect GitHub under Settings > Linked Accounts.'
            : 'GitHub account authorization has expired or was revoked. Reconnect GitHub under Settings > Linked Accounts.',
          !retryable,
        );
      }

      let payload: {
        access_token?: unknown;
        refresh_token?: unknown;
        expires_in?: unknown;
      };
      try {
        payload = (await response.json()) as typeof payload;
      } catch {
        throw new GitHubUserTokenError(
          'GitHub account authorization could not be refreshed. Try again, or reconnect GitHub under Settings > Linked Accounts.',
          false,
        );
      }
      const refreshedAccessToken =
        typeof payload.access_token === 'string' ? payload.access_token : null;
      if (!refreshedAccessToken) {
        throw new GitHubUserTokenError(
          'GitHub account authorization could not be refreshed. Reconnect GitHub under Settings > Linked Accounts.',
          true,
        );
      }

      const refreshedRefreshToken =
        typeof payload.refresh_token === 'string'
          ? payload.refresh_token
          : refreshToken;
      const tokenExpiresAt =
        typeof payload.expires_in === 'number' && payload.expires_in > 0
          ? new Date(now + payload.expires_in * 1000)
          : null;
      const updated = await db
        .update(githubUserMappings)
        .set({
          accessToken: refreshedAccessToken,
          refreshToken: refreshedRefreshToken,
          tokenExpiresAt,
          tokenRefreshClaim: null,
          tokenRefreshClaimedAt: null,
          updatedAt: new Date(now),
        })
        .where(
          and(
            eq(githubUserMappings.id, mapping.id),
            eq(githubUserMappings.userId, userId),
            eq(githubUserMappings.tokenRefreshClaim, claimId),
          ),
        )
        .returning({ id: githubUserMappings.id });

      if (updated.length > 0) return refreshedAccessToken;
    } catch (error) {
      await clearRefreshClaim(mapping.id, userId, claimId);
      throw error;
    }
  }
}

async function clearRefreshClaim(
  mappingId: string,
  userId: string,
  claimId: string,
): Promise<void> {
  await db
    .update(githubUserMappings)
    .set({ tokenRefreshClaim: null, tokenRefreshClaimedAt: null })
    .where(
      and(
        eq(githubUserMappings.id, mappingId),
        eq(githubUserMappings.userId, userId),
        eq(githubUserMappings.tokenRefreshClaim, claimId),
      ),
    );
}
