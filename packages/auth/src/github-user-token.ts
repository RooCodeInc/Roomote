import {
  and,
  db,
  desc,
  eq,
  githubUserMappings,
  resolveDeploymentEnvVar,
  sql,
} from '@roomote/db/server';

const GITHUB_USER_TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000;
const GITHUB_USER_TOKEN_REFRESH_TIMEOUT_MS = 15_000;

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
  const now = options?.now ?? Date.now();

  return db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`github-user:${userId}`}, 0))`,
    );
    const mapping = await tx.query.githubUserMappings.findFirst({
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
    if (
      !mapping.tokenExpiresAt ||
      mapping.tokenExpiresAt.getTime() >
        now + GITHUB_USER_TOKEN_REFRESH_BUFFER_MS
    ) {
      return mapping.accessToken;
    }

    const [clientId, clientSecret] = await Promise.all([
      resolveDeploymentEnvVar('R_GITHUB_CLIENT_ID'),
      resolveDeploymentEnvVar('R_GITHUB_CLIENT_SECRET'),
    ]);
    if (!mapping.refreshToken || !clientId?.trim() || !clientSecret?.trim()) {
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
            refresh_token: mapping.refreshToken,
          }),
          signal: AbortSignal.timeout(
            options?.timeoutMs ?? GITHUB_USER_TOKEN_REFRESH_TIMEOUT_MS,
          ),
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
    const accessToken =
      typeof payload.access_token === 'string' ? payload.access_token : null;
    if (!accessToken) {
      throw new GitHubUserTokenError(
        'GitHub account authorization could not be refreshed. Reconnect GitHub under Settings > Linked Accounts.',
        true,
      );
    }

    const refreshToken =
      typeof payload.refresh_token === 'string'
        ? payload.refresh_token
        : mapping.refreshToken;
    const tokenExpiresAt =
      typeof payload.expires_in === 'number' && payload.expires_in > 0
        ? new Date(now + payload.expires_in * 1000)
        : null;
    await tx
      .update(githubUserMappings)
      .set({
        accessToken,
        refreshToken,
        tokenExpiresAt,
        updatedAt: new Date(now),
      })
      .where(
        and(
          eq(githubUserMappings.id, mapping.id),
          eq(githubUserMappings.userId, userId),
        ),
      );

    return accessToken;
  });
}
