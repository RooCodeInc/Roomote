import jwt from 'jsonwebtoken';

import { Env } from '@roomote/env';
import {
  WORKER_RELEASE_REPOSITORY_FULL_NAME,
  WORKER_RELEASE_REPOSITORY_NAME,
} from './worker-release-repository';

const GITHUB_API_BASE = 'https://api.github.com';
const GITHUB_API_VERSION = '2022-11-28';
const TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000;

interface GitHubInstallation {
  id: number;
}

interface GitHubInstallationAccessToken {
  token: string;
  expires_at: string;
}

interface WorkerReleaseGitHubAuth {
  token: string;
  expiresAt: number;
}

let cachedAuth: WorkerReleaseGitHubAuth | null = null;
let inflightAuth: Promise<WorkerReleaseGitHubAuth> | null = null;

function normalizeGitHubAppPrivateKey(privateKey: string): string {
  return privateKey.replace(/\\n/g, '\n').replace(/"/g, '').trim();
}

function buildGitHubAppJwt(): string {
  const now = Math.floor(Date.now() / 1000);

  return jwt.sign(
    {
      iat: now,
      exp: now + 300,
      iss: Env.R_GITHUB_APP_ID,
    },
    normalizeGitHubAppPrivateKey(Env.R_GITHUB_APP_PRIVATE_KEY),
    { algorithm: 'RS256' },
  );
}

function isCachedAuthUsable(now = Date.now()): boolean {
  return (
    cachedAuth !== null && cachedAuth.expiresAt - TOKEN_REFRESH_BUFFER_MS > now
  );
}

async function fetchWorkerReleaseInstallationId(
  jwtToken: string,
): Promise<number> {
  const response = await fetch(
    `${GITHUB_API_BASE}/repos/${WORKER_RELEASE_REPOSITORY_FULL_NAME}/installation`,
    {
      headers: {
        Authorization: `Bearer ${jwtToken}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': GITHUB_API_VERSION,
      },
    },
  );

  if (!response.ok) {
    throw new Error(
      `Failed to resolve GitHub App installation for ${WORKER_RELEASE_REPOSITORY_FULL_NAME}: ${response.status} ${response.statusText}`,
    );
  }

  const installation = (await response.json()) as GitHubInstallation;
  return installation.id;
}

async function createInstallationAccessToken(
  jwtToken: string,
  installationId: number,
): Promise<WorkerReleaseGitHubAuth> {
  const response = await fetch(
    `${GITHUB_API_BASE}/app/installations/${installationId}/access_tokens`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${jwtToken}`,
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json',
        'X-GitHub-Api-Version': GITHUB_API_VERSION,
      },
      body: JSON.stringify({
        repositories: [WORKER_RELEASE_REPOSITORY_NAME],
        permissions: {
          contents: 'read',
        },
      }),
    },
  );

  if (!response.ok) {
    throw new Error(
      `Failed to mint GitHub App installation token for worker releases: ${response.status} ${response.statusText}`,
    );
  }

  const payload = (await response.json()) as GitHubInstallationAccessToken;
  const expiresAt = Date.parse(payload.expires_at);

  if (!payload.token || Number.isNaN(expiresAt)) {
    throw new Error(
      'GitHub App installation token response for worker releases was missing token expiry metadata',
    );
  }

  return {
    token: payload.token,
    expiresAt,
  };
}

async function fetchWorkerReleaseGitHubAuth(): Promise<WorkerReleaseGitHubAuth> {
  const jwtToken = buildGitHubAppJwt();
  const installationId = await fetchWorkerReleaseInstallationId(jwtToken);
  return createInstallationAccessToken(jwtToken, installationId);
}

export async function getWorkerReleaseGitHubToken(): Promise<string> {
  if (isCachedAuthUsable()) {
    return cachedAuth!.token;
  }

  if (!inflightAuth) {
    inflightAuth = fetchWorkerReleaseGitHubAuth()
      .then((auth) => {
        cachedAuth = auth;
        return auth;
      })
      .finally(() => {
        inflightAuth = null;
      });
  }

  const auth = await inflightAuth;
  return auth.token;
}

export function clearWorkerReleaseGitHubAuthCache(): void {
  cachedAuth = null;
  inflightAuth = null;
}
