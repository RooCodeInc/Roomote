import { createHash } from 'node:crypto';

import { Octokit } from '@octokit/rest';
import jwt from 'jsonwebtoken';
import { z } from 'zod';

import { Env } from '@roomote/env';
import { normalizePemEnvValue } from '@roomote/types';
import {
  type GitHubInstallation,
  db,
  users,
  githubInstallations,
  eq,
  and,
  isNull,
  desc,
  resolveDeploymentEnvVar,
} from '@roomote/db/server';

export const createGitHubTokenOptionsSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('activeInstallation') }),
  z.object({ type: z.literal('userId'), userId: z.string() }),
  z.object({
    type: z.literal('installationId'),
    installationId: z.string().or(z.number()),
    // GitHub repository ids to scope the token to. When omitted, the token
    // covers every repository in the installation.
    repositoryIds: z.array(z.number()).optional(),
  }),
]);

export type CreateGitHubTokenOptions = z.infer<
  typeof createGitHubTokenOptionsSchema
>;

export type GitHubAppCredentials = { appId: string; privateKey: string };

export type GitHubTokenMetadata = {
  token: string;
  expiresAt: Date | null;
};

export type CreateGitHubTokenRuntimeOptions = {
  /** Reuse a valid token for this exact app, installation, and repo scope. */
  cache?: boolean;
  /** Ignore and replace any cached token for this scope. */
  forceRefresh?: boolean;
  /** Upper bound on token reuse, independent of the provider expiry. */
  maxCacheAgeMs?: number;
  /** Called only when this process sends a token-mint POST to GitHub. */
  onTokenMintRequest?: () => void;
};

const GITHUB_TOKEN_CACHE_REFRESH_BUFFER_MS = 5 * 60 * 1000;
const GITHUB_TOKEN_CACHE_MAX_AGE_MS = 15 * 60 * 1000;
const GITHUB_TOKEN_CACHE_MAX_ENTRIES = 500;

const githubTokenCache = new Map<
  string,
  { metadata: GitHubTokenMetadata; storedAt: number }
>();
const githubTokenMintsInFlight = new Map<
  string,
  Promise<GitHubTokenMetadata>
>();

function normalizeRepositoryIds(repositoryIds?: number[]): number[] {
  return [...new Set(repositoryIds ?? [])].sort((left, right) => left - right);
}

function getCredentialFingerprint(credentials: GitHubAppCredentials): string {
  return createHash('sha256')
    .update(credentials.appId)
    .update('\0')
    .update(normalizePemEnvValue(credentials.privateKey))
    .digest('hex');
}

function getGitHubTokenCacheKey({
  credentials,
  installationId,
  repositoryIds,
}: {
  credentials: GitHubAppCredentials;
  installationId: number;
  repositoryIds: number[];
}): string {
  return [
    getCredentialFingerprint(credentials),
    String(installationId),
    repositoryIds.join(','),
  ].join(':');
}

function getCachedGitHubToken(
  cacheKey: string,
  maxCacheAgeMs: number,
  now = Date.now(),
): GitHubTokenMetadata | null {
  const cached = githubTokenCache.get(cacheKey);

  if (
    !cached?.metadata.expiresAt ||
    cached.metadata.expiresAt.getTime() -
      GITHUB_TOKEN_CACHE_REFRESH_BUFFER_MS <=
      now ||
    cached.storedAt + maxCacheAgeMs <= now
  ) {
    githubTokenCache.delete(cacheKey);
    return null;
  }

  // Refresh insertion order so the bounded cache evicts the least recently
  // used scope first.
  githubTokenCache.delete(cacheKey);
  githubTokenCache.set(cacheKey, cached);
  return cached.metadata;
}

function cacheGitHubToken(
  cacheKey: string,
  metadata: GitHubTokenMetadata,
): void {
  if (!metadata.expiresAt) {
    return;
  }

  githubTokenCache.delete(cacheKey);
  githubTokenCache.set(cacheKey, { metadata, storedAt: Date.now() });

  while (githubTokenCache.size > GITHUB_TOKEN_CACHE_MAX_ENTRIES) {
    const oldestKey = githubTokenCache.keys().next().value;
    if (typeof oldestKey !== 'string') {
      break;
    }
    githubTokenCache.delete(oldestKey);
  }
}

function getErrorHeader(error: unknown, name: string): string | null {
  if (
    typeof error !== 'object' ||
    error === null ||
    !('response' in error) ||
    typeof error.response !== 'object' ||
    error.response === null ||
    !('headers' in error.response) ||
    typeof error.response.headers !== 'object' ||
    error.response.headers === null
  ) {
    return null;
  }

  const entry = Object.entries(
    error.response.headers as Record<string, unknown>,
  ).find(([key]) => key.toLowerCase() === name.toLowerCase());
  const value = entry?.[1];

  return typeof value === 'string' || typeof value === 'number'
    ? String(value)
    : null;
}

function getErrorStatus(error: unknown): number | null {
  if (typeof error !== 'object' || error === null || !('status' in error)) {
    return null;
  }

  const status = Number(error.status);
  return Number.isFinite(status) ? status : null;
}

function getRateLimitResetAt(error: unknown): string | null {
  const resetSeconds = Number(getErrorHeader(error, 'x-ratelimit-reset'));
  return Number.isFinite(resetSeconds) && resetSeconds > 0
    ? new Date(resetSeconds * 1000).toISOString()
    : null;
}

async function mintGitHubToken({
  installationId,
  repositoryIds,
  appCredentials,
  runtimeOptions,
}: {
  installationId: number;
  repositoryIds: number[];
  appCredentials: GitHubAppCredentials;
  runtimeOptions?: CreateGitHubTokenRuntimeOptions;
}): Promise<GitHubTokenMetadata> {
  const startedAt = Date.now();
  runtimeOptions?.onTokenMintRequest?.();

  try {
    const {
      data: { token, expires_at: expiresAtValue },
    } = await getOctokit(
      appCredentials,
    ).rest.apps.createInstallationAccessToken({
      installation_id: installationId,
      ...(repositoryIds.length > 0 ? { repository_ids: repositoryIds } : {}),
    });
    const parsedExpiresAt = expiresAtValue ? new Date(expiresAtValue) : null;
    const expiresAt =
      parsedExpiresAt && !Number.isNaN(parsedExpiresAt.getTime())
        ? parsedExpiresAt
        : null;

    console.log(
      JSON.stringify({
        event: 'github_installation_token_mint',
        outcome: 'success',
        installationId,
        repositoryCount: repositoryIds.length,
        expiresAt: expiresAt?.toISOString() ?? null,
        durationMs: Date.now() - startedAt,
      }),
    );

    return { token, expiresAt };
  } catch (error) {
    console.warn(
      JSON.stringify({
        event: 'github_installation_token_mint',
        outcome: 'error',
        installationId,
        repositoryCount: repositoryIds.length,
        status: getErrorStatus(error),
        remaining: getErrorHeader(error, 'x-ratelimit-remaining'),
        resetAt: getRateLimitResetAt(error),
        retryAfter: getErrorHeader(error, 'retry-after'),
        durationMs: Date.now() - startedAt,
      }),
    );
    throw error;
  }
}

export async function createGitHubToken(
  options: CreateGitHubTokenOptions,
  octokitOptions?: GitHubAppCredentials,
  runtimeOptions?: CreateGitHubTokenRuntimeOptions,
): Promise<string> {
  const metadata = await createGitHubTokenWithMetadata(
    options,
    octokitOptions,
    runtimeOptions,
  );
  return metadata.token;
}

export async function createGitHubTokenWithMetadata(
  options: CreateGitHubTokenOptions,
  octokitOptions?: GitHubAppCredentials,
  runtimeOptions?: CreateGitHubTokenRuntimeOptions,
): Promise<GitHubTokenMetadata> {
  let installation: GitHubInstallation | undefined;

  if (options.type === 'activeInstallation') {
    const activeInstallations = await db.query.githubInstallations.findMany({
      where: isNull(githubInstallations.suspendedAt),
      orderBy: [desc(githubInstallations.createdAt)],
      limit: 2,
    });

    if (activeInstallations.length > 1) {
      throw new Error(
        'Multiple active GitHub installations found. Select a specific environment or repository before starting this task.',
      );
    }

    installation = activeInstallations[0];
  } else if (options.type === 'userId') {
    const user = await db.query.users.findFirst({
      where: eq(users.id, options.userId),
    });

    installation = user
      ? await db.query.githubInstallations.findFirst({
          where: and(
            eq(githubInstallations.userId, user.id),
            isNull(githubInstallations.suspendedAt),
          ),
          orderBy: [desc(githubInstallations.createdAt)],
        })
      : undefined;
  } else if (options.type === 'installationId') {
    installation =
      typeof options.installationId === 'string'
        ? await db.query.githubInstallations.findFirst({
            where: eq(githubInstallations.id, options.installationId),
          })
        : await db.query.githubInstallations.findFirst({
            where: eq(
              githubInstallations.installationId,
              options.installationId,
            ),
          });
  } else {
    throw new Error('Invalid options.');
  }

  if (!installation) {
    throw new Error('❌ GitHub installation not found');
  }

  const appCredentials =
    await resolveRuntimeGitHubAppCredentials(octokitOptions);

  // Scope the token to specific repositories when the caller supplied them, so
  // a task token cannot read or write other repositories in the installation.
  const repositoryIds = normalizeRepositoryIds(
    options.type === 'installationId' ? options.repositoryIds : undefined,
  );
  const cacheKey = getGitHubTokenCacheKey({
    credentials: appCredentials,
    installationId: installation.installationId,
    repositoryIds,
  });
  const cacheEnabled = runtimeOptions?.cache === true;
  const forceRefresh = runtimeOptions?.forceRefresh === true;
  const maxCacheAgeMs = Math.max(
    0,
    runtimeOptions?.maxCacheAgeMs ?? GITHUB_TOKEN_CACHE_MAX_AGE_MS,
  );

  if (cacheEnabled && forceRefresh) {
    githubTokenCache.delete(cacheKey);
  }

  if (cacheEnabled && !forceRefresh) {
    const cached = getCachedGitHubToken(cacheKey, maxCacheAgeMs);
    if (cached) {
      return cached;
    }
  }

  const existingMint = githubTokenMintsInFlight.get(cacheKey);
  if (existingMint) {
    return existingMint;
  }

  const mint = mintGitHubToken({
    installationId: installation.installationId,
    repositoryIds,
    appCredentials,
    runtimeOptions,
  })
    .then((metadata) => {
      if (cacheEnabled) {
        cacheGitHubToken(cacheKey, metadata);
      }
      return metadata;
    })
    .finally(() => {
      githubTokenMintsInFlight.delete(cacheKey);
    });
  githubTokenMintsInFlight.set(cacheKey, mint);

  return mint;
}

export function clearGitHubTokenCacheForTesting(): void {
  githubTokenCache.clear();
  githubTokenMintsInFlight.clear();
}

export function resolveGitHubAppCredentials(
  options?: GitHubAppCredentials,
): GitHubAppCredentials {
  if (options) {
    return options;
  }

  return {
    appId: Env.R_GITHUB_APP_ID,
    privateKey: Env.R_GITHUB_APP_PRIVATE_KEY,
  };
}

export async function resolveRuntimeGitHubAppCredentials(
  options?: GitHubAppCredentials,
): Promise<GitHubAppCredentials> {
  if (options) {
    return options;
  }

  const [appId, privateKey] = await Promise.all([
    resolveDeploymentEnvVar('R_GITHUB_APP_ID'),
    resolveDeploymentEnvVar('R_GITHUB_APP_PRIVATE_KEY'),
  ]);

  if (appId && privateKey) {
    return { appId, privateKey };
  }

  const envCredentials = resolveGitHubAppCredentials();

  if (envCredentials.appId?.trim() && envCredentials.privateKey?.trim()) {
    return envCredentials;
  }

  throw new Error('GitHub App credentials are not configured.');
}

function getOctokit(options?: GitHubAppCredentials): Octokit {
  const now = Math.floor(Date.now() / 1000);
  const { appId, privateKey } = resolveGitHubAppCredentials(options);

  const auth = jwt.sign(
    { iat: now, exp: now + 300, iss: appId },
    normalizePemEnvValue(
      privateKey.replace(/\\n/g, '\n').replace(/"/g, '').trim(),
    ),
    { algorithm: 'RS256' },
  );

  return new Octokit({ auth, userAgent: 'Roomote' });
}
