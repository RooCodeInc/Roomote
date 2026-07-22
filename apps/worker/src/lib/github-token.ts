import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'fs';
import { createServer } from 'http';
import { homedir } from 'os';
import { join } from 'path';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';

import {
  getSourceControlTokenEnvVars,
  type SourceControlGitCredential,
  type SourceControlProxyCredential,
  type SourceControlTokenEnvVar,
  type SourceControlTokenMetadata,
} from '@roomote/types';

const GH_TOKEN_DIR = join(homedir(), '.roomote');

export const GH_CLI_WRAPPER_BIN_DIR = join(GH_TOKEN_DIR, 'bin');

const GH_CLI_WRAPPER_PATH = join(GH_CLI_WRAPPER_BIN_DIR, 'gh');
const GH_TOKEN_FILE_PATH = join(GH_TOKEN_DIR, 'gh-token');
const LEGACY_GITLAB_TOKEN_FILE_PATH = join(GH_TOKEN_DIR, 'gitlab-token');
const LEGACY_GITLAB_CREDENTIALS_FILE_PATH = join(
  GH_TOKEN_DIR,
  'gitlab-repository-credentials.tsv',
);
const SOURCE_CONTROL_CREDENTIALS_FILE_PATH = join(
  GH_TOKEN_DIR,
  'source-control-repository-credentials.tsv',
);
export const SOURCE_CONTROL_GIT_CONFIG_PATH = join(
  GH_TOKEN_DIR,
  'source-control-gitconfig',
);
const SOURCE_CONTROL_PROXY_ROUTE_PREFIX = '/source-control';
const GIT_CREDENTIAL_HELPER_PATH = join(
  GH_TOKEN_DIR,
  'git-credential-roomote.sh',
);

const GH_TOKEN_ENV_SCRIPT = `#!/usr/bin/env bash
GH_TOKEN_FILE="$HOME/.roomote/gh-token"

if [ -r "$GH_TOKEN_FILE" ]; then
  export GH_TOKEN="$(cat "$GH_TOKEN_FILE")"
else
  unset GH_TOKEN
fi
`;

const GITLAB_TOKEN_ENV_SCRIPT = `#!/usr/bin/env bash
unset GITLAB_TOKEN
`;

const GITEA_TOKEN_ENV_SCRIPT = `#!/usr/bin/env bash
unset GITEA_TOKEN
`;

const ADO_TOKEN_ENV_SCRIPT = `#!/usr/bin/env bash
unset ADO_TOKEN
`;

/**
 * Custom git credential helper that reads provider credentials from files on
 * every invocation. GitHub keeps using a single file-backed token so `gh auth
 * setup-git` and HTTPS git operations see the freshest token. GitLab keeps
 * using scoped repository credentials written to a file because those tokens
 * are already short-lived and repository-scoped.
 */
const GIT_CREDENTIAL_HELPER_SCRIPT = `#!/usr/bin/env bash
GH_TOKEN_FILE="$HOME/.roomote/gh-token"
SOURCE_CONTROL_CREDENTIALS_FILE="$HOME/.roomote/source-control-repository-credentials.tsv"

HOST=""
PATH_VALUE=""
PROTOCOL=""

while IFS='=' read -r key value; do
  case "$key" in
    host) HOST="$value" ;;
    path) PATH_VALUE="$value" ;;
    protocol) PROTOCOL="$value" ;;
  esac
done

normalize_repository_path() {
  local raw="$1"
  raw="\${raw#/}"
  raw="\${raw%.git}"
  raw="\${raw%/}"
  printf '%s' "$raw"
}

case "$1" in
  get)
    case "$HOST" in
      github.com)
        if [ -r "$GH_TOKEN_FILE" ]; then
          TOKEN="$(tr -d '\\n' < "$GH_TOKEN_FILE")"
          if [ -n "$TOKEN" ]; then
            echo "protocol=\${PROTOCOL:-https}"
            echo "host=$HOST"
            echo "username=x-access-token"
            echo "password=$TOKEN"
            echo ""
          fi
        fi
        ;;
      *)
        REPOSITORY_PATH="$(normalize_repository_path "$PATH_VALUE")"
        if [ -n "$HOST" ] && [ -n "$REPOSITORY_PATH" ] && [ -r "$SOURCE_CONTROL_CREDENTIALS_FILE" ]; then
          while IFS=$'\\t' read -r credential_host repo username token; do
            if [ "$credential_host" = "$HOST" ] && [ "$repo" = "$REPOSITORY_PATH" ] && [ -n "$username" ] && [ -n "$token" ]; then
              echo "protocol=\${PROTOCOL:-https}"
              echo "host=$HOST"
              echo "path=$PATH_VALUE"
              echo "username=$username"
              echo "password=$token"
              echo ""
              break
            fi
          done < "$SOURCE_CONTROL_CREDENTIALS_FILE"
        fi
        ;;
    esac
    ;;
  store|erase)
    # Nothing to do – the worker manages the credential lifecycle.
    ;;
esac
`;

/**
 * File-backed gh CLI wrapper. Long-lived task processes inherit GH_TOKEN only
 * once at startup, so later `gh` invocations keep using a stale env var even
 * after the worker refresh loop updates ~/.roomote/gh-token. Prepending this
 * wrapper directory to PATH makes every `gh` process reload the latest token
 * from disk right before executing the real gh binary.
 */
const GH_CLI_WRAPPER_SCRIPT = `#!/usr/bin/env bash
GH_TOKEN_FILE="$HOME/.roomote/gh-token"

if [ -r "$GH_TOKEN_FILE" ]; then
  export GH_TOKEN="$(tr -d '\\n' < "$GH_TOKEN_FILE")"
else
  unset GH_TOKEN
fi

SELF_DIR="$(cd "$(dirname "\${BASH_SOURCE[0]}")" && pwd)"
IFS=':' read -r -a PATH_ENTRIES <<< "\${PATH:-}"

for entry in "\${PATH_ENTRIES[@]}"; do
  if [ -z "$entry" ] || [ "$entry" = "$SELF_DIR" ]; then
    continue
  fi

  candidate="$entry/gh"

  if [ -x "$candidate" ]; then
    exec "$candidate" "$@"
  fi
done

echo "gh wrapper could not find the real gh executable on PATH" >&2
exit 127
`;

export const GH_TOKEN_ENV_FILE_PATH = join(GH_TOKEN_DIR, 'gh-token-env.sh');
export const GITLAB_TOKEN_ENV_FILE_PATH = join(
  GH_TOKEN_DIR,
  'gitlab-token-env.sh',
);
export const GITEA_TOKEN_ENV_FILE_PATH = join(
  GH_TOKEN_DIR,
  'gitea-token-env.sh',
);
export const ADO_TOKEN_ENV_FILE_PATH = join(GH_TOKEN_DIR, 'ado-token-env.sh');

/**
 * Path to the common env file that is sourced by both .bashrc (interactive
 * shells) and BASH_ENV (non-interactive shells). It contains all user-facing
 * env var exports and sources provider token env scripts.
 */
export const COMMON_ENV_FILE_PATH = join(GH_TOKEN_DIR, 'env.sh');

type SourceControlProxyTarget = {
  key: string;
  originBaseUrl: string;
  credentials: SourceControlProxyCredential[];
};

type RequestInitWithDuplex = RequestInit & {
  duplex?: 'half';
};

let sourceControlProxyTargets = new Map<string, SourceControlProxyTarget>();
let sourceControlProxyPortPromise: Promise<number> | null = null;

function ensureGhTokenEnvFile(): string {
  ensureGhTokenDirectory();
  writeFileSync(GH_TOKEN_ENV_FILE_PATH, GH_TOKEN_ENV_SCRIPT, { mode: 0o600 });
  return GH_TOKEN_ENV_FILE_PATH;
}

function ensureGitLabTokenEnvFile(): string {
  ensureGhTokenDirectory();
  writeFileSync(GITLAB_TOKEN_ENV_FILE_PATH, GITLAB_TOKEN_ENV_SCRIPT, {
    mode: 0o600,
  });
  return GITLAB_TOKEN_ENV_FILE_PATH;
}

function ensureGiteaTokenEnvFile(): string {
  ensureGhTokenDirectory();
  writeFileSync(GITEA_TOKEN_ENV_FILE_PATH, GITEA_TOKEN_ENV_SCRIPT, {
    mode: 0o600,
  });
  return GITEA_TOKEN_ENV_FILE_PATH;
}

function ensureAdoTokenEnvFile(): string {
  ensureGhTokenDirectory();
  writeFileSync(ADO_TOKEN_ENV_FILE_PATH, ADO_TOKEN_ENV_SCRIPT, {
    mode: 0o600,
  });
  return ADO_TOKEN_ENV_FILE_PATH;
}

/**
 * Delete the on-disk source-control credential material (the GitHub token
 * file and scoped repository credentials). Called before filesystem
 * snapshots so tokens never persist inside snapshot images; the injection
 * path recreates these files at the next run start. The credential helper,
 * gh wrapper, and token env scripts all tolerate missing files.
 */
export function removeSourceControlCredentialFiles(): void {
  const credentialFilePaths = [
    GH_TOKEN_FILE_PATH,
    SOURCE_CONTROL_CREDENTIALS_FILE_PATH,
    LEGACY_GITLAB_TOKEN_FILE_PATH,
    LEGACY_GITLAB_CREDENTIALS_FILE_PATH,
  ];

  for (const filePath of credentialFilePaths) {
    rmSync(filePath, { force: true });
  }
}

function ensureSourceControlGitConfigFile(): void {
  ensureGhTokenDirectory();
  if (!existsSync(SOURCE_CONTROL_GIT_CONFIG_PATH)) {
    resetSourceControlProxyGitConfig();
  }
}

function resetSourceControlProxyGitConfig(): void {
  ensureGhTokenDirectory();
  writeFileSync(
    SOURCE_CONTROL_GIT_CONFIG_PATH,
    '# Auto-generated by the worker. Do not edit manually.\n',
    { mode: 0o600 },
  );
}

export function ensureSourceControlTokenEnvFiles(): void {
  ensureGhTokenEnvFile();
  ensureGitLabTokenEnvFile();
  ensureGiteaTokenEnvFile();
  ensureAdoTokenEnvFile();
  ensureSourceControlGitConfigFile();
}

/**
 * Write the custom git credential helper script and return its path.
 * The script is executable (0o755) so git can invoke it directly.
 */
export function ensureGitCredentialHelper(): string {
  ensureGhTokenDirectory();

  writeFileSync(GIT_CREDENTIAL_HELPER_PATH, GIT_CREDENTIAL_HELPER_SCRIPT, {
    mode: 0o755,
  });

  return GIT_CREDENTIAL_HELPER_PATH;
}

export function ensureGhCliWrapper(): string {
  ensureGhTokenDirectory();
  mkdirSync(GH_CLI_WRAPPER_BIN_DIR, { recursive: true });

  writeFileSync(GH_CLI_WRAPPER_PATH, GH_CLI_WRAPPER_SCRIPT, {
    mode: 0o755,
  });

  return GH_CLI_WRAPPER_PATH;
}

type GitHubTokenFileStatus = {
  present: boolean;
  nonEmpty: boolean;
};

/**
 * Redacted status of the file-backed GitHub token the git credential helper
 * reads. Exposes only presence signals, never token material, so callers can
 * log it and fail fast before attempting anonymous git operations.
 */
export function getGitHubTokenFileStatus(): GitHubTokenFileStatus {
  try {
    const content = readFileSync(GH_TOKEN_FILE_PATH, 'utf-8');
    return { present: true, nonEmpty: content.trim().length > 0 };
  } catch {
    return { present: false, nonEmpty: false };
  }
}

function writeGhToken(token: string): void {
  ensureGhTokenDirectory();
  writeFileSync(GH_TOKEN_FILE_PATH, `${token}\n`, { mode: 0o600 });
}

function clearGhToken(): void {
  rmSync(GH_TOKEN_FILE_PATH, { force: true });
}

function writeSourceControlRepositoryCredentials(
  credentials: SourceControlGitCredential[],
): void {
  ensureGhTokenDirectory();
  clearLegacySourceControlCredentials();

  const content = credentials
    .map((credential) => {
      const host = credential.host.trim();
      const repositoryFullName = credential.repositoryFullName.trim();
      const username = credential.username.trim();
      const token = credential.token.trim();

      return `${host}\t${repositoryFullName}\t${username}\t${token}`;
    })
    .join('\n');

  writeFileSync(
    SOURCE_CONTROL_CREDENTIALS_FILE_PATH,
    content ? `${content}\n` : '',
    { mode: 0o600 },
  );
}

function clearSourceControlRepositoryCredentials(): void {
  rmSync(SOURCE_CONTROL_CREDENTIALS_FILE_PATH, { force: true });
  clearLegacySourceControlCredentials();
}

function clearLegacySourceControlCredentials(): void {
  rmSync(LEGACY_GITLAB_TOKEN_FILE_PATH, { force: true });
  rmSync(LEGACY_GITLAB_CREDENTIALS_FILE_PATH, { force: true });
}

function writeSourceControlToken(
  envVar: SourceControlTokenEnvVar,
  token: string,
): void {
  switch (envVar) {
    case 'GH_TOKEN':
      writeGhToken(token);
      break;
    case 'GITLAB_TOKEN':
    case 'GITEA_TOKEN':
    case 'ADO_TOKEN':
      clearSourceControlRepositoryCredentials();
      break;
  }
}

function clearSourceControlToken(envVar: SourceControlTokenEnvVar): void {
  switch (envVar) {
    case 'GH_TOKEN':
      clearGhToken();
      break;
    case 'GITLAB_TOKEN':
    case 'GITEA_TOKEN':
    case 'ADO_TOKEN':
      clearSourceControlRepositoryCredentials();
      break;
  }
}

function normalizeRepositoryPath(rawPath: string): string {
  return rawPath
    .replace(/^\/+/, '')
    .replace(/\.git$/, '')
    .replace(/\/+$/, '');
}

function normalizeOriginBaseUrl(
  value: string | undefined,
  host: string,
): string {
  if (value?.trim()) {
    return new URL(value).toString().replace(/\/+$/, '');
  }

  return `https://${host}`;
}

function buildProxyTargetKey(credential: SourceControlProxyCredential): string {
  const originBaseUrl = normalizeOriginBaseUrl(
    credential.originBaseUrl,
    credential.host,
  );

  return Buffer.from(
    `${credential.provider}\n${originBaseUrl}`,
    'utf8',
  ).toString('base64url');
}

function buildProxyTargets(
  credentials: SourceControlProxyCredential[],
): SourceControlProxyTarget[] {
  const groupedTargets = new Map<string, SourceControlProxyTarget>();

  for (const credential of credentials) {
    const key = buildProxyTargetKey(credential);
    const existing = groupedTargets.get(key);

    if (existing) {
      existing.credentials.push(credential);
      continue;
    }

    groupedTargets.set(key, {
      key,
      originBaseUrl: normalizeOriginBaseUrl(
        credential.originBaseUrl,
        credential.host,
      ),
      credentials: [credential],
    });
  }

  return [...groupedTargets.values()].map((target) => ({
    ...target,
    credentials: [...target.credentials].sort(
      (left, right) =>
        right.repositoryFullName.length - left.repositoryFullName.length,
    ),
  }));
}

function buildSourceControlProxyPrefix(port: number, key: string): string {
  return `http://127.0.0.1:${port}${SOURCE_CONTROL_PROXY_ROUTE_PREFIX}/${key}/`;
}

function buildSourceControlProxyGitConfig(
  targets: SourceControlProxyTarget[],
  port: number,
): string {
  const lines = ['# Auto-generated by the worker. Do not edit manually.', ''];

  for (const target of targets.sort((left, right) =>
    left.originBaseUrl.localeCompare(right.originBaseUrl),
  )) {
    lines.push(
      `[url "${buildSourceControlProxyPrefix(port, target.key)}"]`,
      `\tinsteadOf = ${target.originBaseUrl.replace(/\/+$/, '')}/`,
      '',
    );
  }

  return lines.join('\n');
}

function writeSourceControlProxyGitConfig(
  targets: SourceControlProxyTarget[],
  port: number,
): void {
  ensureGhTokenDirectory();
  writeFileSync(
    SOURCE_CONTROL_GIT_CONFIG_PATH,
    buildSourceControlProxyGitConfig(targets, port),
    { mode: 0o600 },
  );
}

function buildBasicAuthHeader(username: string, token: string): string {
  return `Basic ${Buffer.from(`${username}:${token}`, 'utf8').toString(
    'base64',
  )}`;
}

function buildGitAuthHeader(
  username: string,
  token: string,
  authScheme: 'basic' | 'bearer' = 'basic',
): string {
  return authScheme === 'bearer'
    ? `Bearer ${token}`
    : buildBasicAuthHeader(username, token);
}

function resolveProxyCredential(
  target: SourceControlProxyTarget,
  proxiedPath: string,
): SourceControlProxyCredential | null {
  const normalizedPath = proxiedPath.replace(/^\/+/, '');

  for (const credential of target.credentials) {
    const repositoryPath = normalizeRepositoryPath(
      credential.repositoryFullName.trim(),
    );

    if (matchesAllowedGitPath(repositoryPath, normalizedPath)) {
      return credential;
    }
  }

  return null;
}

function matchesAllowedGitPath(
  repositoryPath: string,
  requestedPath: string,
): boolean {
  const bases = repositoryPath.endsWith('.git')
    ? [repositoryPath]
    : [repositoryPath, `${repositoryPath}.git`];
  const allowedSuffixes = [
    '',
    '/',
    '/info/refs',
    '/git-upload-pack',
    '/git-receive-pack',
  ];

  return bases.some((base) =>
    allowedSuffixes.some((suffix) => requestedPath === `${base}${suffix}`),
  );
}

function buildProxyForwardHeaders(
  requestHeaders: Headers,
  authorizationHeader: string,
): Headers {
  const headers = new Headers();

  for (const [key, value] of requestHeaders.entries()) {
    const lowerKey = key.toLowerCase();

    if (
      lowerKey === 'authorization' ||
      lowerKey === 'connection' ||
      lowerKey === 'content-length' ||
      lowerKey === 'host' ||
      lowerKey.startsWith('proxy-')
    ) {
      continue;
    }

    headers.set(key, value);
  }

  headers.set('authorization', authorizationHeader);
  return headers;
}

async function handleSourceControlProxyRequest(
  request: Request,
): Promise<Response> {
  const url = new URL(request.url);
  const pathParts = url.pathname.split('/').filter(Boolean);

  if (pathParts[0] !== SOURCE_CONTROL_PROXY_ROUTE_PREFIX.replace('/', '')) {
    return new Response('Not found\n', {
      status: 404,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    });
  }

  const targetKey = pathParts[1];
  const proxiedPath = pathParts.slice(2).join('/');

  if (!targetKey || !proxiedPath) {
    return new Response('Missing repository target\n', {
      status: 400,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    });
  }

  if (!['GET', 'HEAD', 'POST'].includes(request.method.toUpperCase())) {
    return new Response('Method not allowed\n', {
      status: 405,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    });
  }

  const target = sourceControlProxyTargets.get(targetKey);

  if (!target) {
    return new Response('Unknown source control target\n', {
      status: 404,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    });
  }

  const credential = resolveProxyCredential(target, proxiedPath);

  if (!credential) {
    return new Response('Repository access denied\n', {
      status: 403,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    });
  }

  const upstreamUrl = new URL(target.originBaseUrl);
  upstreamUrl.pathname =
    `${upstreamUrl.pathname.replace(/\/+$/, '')}/${proxiedPath}`.replace(
      /\/{2,}/g,
      '/',
    );
  upstreamUrl.search = url.search;

  const upstreamResponse = await fetch(upstreamUrl, {
    method: request.method,
    headers: buildProxyForwardHeaders(
      request.headers,
      buildGitAuthHeader(
        credential.username,
        credential.token,
        credential.authScheme,
      ),
    ),
    body:
      request.method === 'GET' || request.method === 'HEAD'
        ? undefined
        : request.body,
    duplex:
      request.method === 'GET' || request.method === 'HEAD'
        ? undefined
        : 'half',
    redirect: 'manual',
  } as RequestInitWithDuplex);

  const responseHeaders = new Headers(upstreamResponse.headers);
  responseHeaders.delete('connection');
  responseHeaders.delete('transfer-encoding');

  return new Response(upstreamResponse.body, {
    status: upstreamResponse.status,
    statusText: upstreamResponse.statusText,
    headers: responseHeaders,
  });
}

async function ensureSourceControlProxyPort(): Promise<number> {
  if (sourceControlProxyPortPromise) {
    return sourceControlProxyPortPromise;
  }

  sourceControlProxyPortPromise = new Promise<number>((resolve, reject) => {
    const server = createServer(async (req, res) => {
      try {
        const requestUrl = new URL(
          req.url ?? '/',
          'http://127.0.0.1',
        ).toString();
        const request = new Request(requestUrl, {
          method: req.method,
          headers: req.headers as HeadersInit,
          body: req.method === 'GET' || req.method === 'HEAD' ? undefined : req,
          duplex:
            req.method === 'GET' || req.method === 'HEAD' ? undefined : 'half',
        } as RequestInitWithDuplex);
        const response = await handleSourceControlProxyRequest(request);

        res.statusCode = response.status;
        response.headers.forEach((value, key) => {
          // fetch transparently decodes compressed upstream bodies, so
          // forwarding these headers makes git try to decode the plain body
          // again ("incorrect header check" on gzip-served hosts like
          // gitlab.com).
          const lowerKey = key.toLowerCase();
          if (
            lowerKey === 'content-encoding' ||
            lowerKey === 'content-length' ||
            lowerKey === 'transfer-encoding' ||
            lowerKey === 'connection'
          ) {
            return;
          }

          res.setHeader(key, value);
        });

        if (!response.body) {
          res.end();
          return;
        }

        await pipeline(Readable.fromWeb(response.body as never), res);
      } catch (error) {
        if (!res.headersSent) {
          res.statusCode = 502;
          res.setHeader('content-type', 'text/plain; charset=utf-8');
        }

        res.end(
          `Source control proxy failed: ${
            error instanceof Error ? error.message : String(error)
          }\n`,
        );
      }
    });

    server.on('error', (error) => {
      sourceControlProxyPortPromise = null;
      reject(error);
    });

    server.listen(0, '127.0.0.1', () => {
      const address = server.address();

      if (!address || typeof address === 'string') {
        sourceControlProxyPortPromise = null;
        reject(new Error('Failed to bind source control proxy.'));
        return;
      }

      resolve(address.port);
    });
  });

  return sourceControlProxyPortPromise;
}

async function applySourceControlProxyCredentials(
  proxyCredentials: SourceControlProxyCredential[],
): Promise<void> {
  if (proxyCredentials.length === 0) {
    sourceControlProxyTargets = new Map();
    resetSourceControlProxyGitConfig();
    return;
  }

  const port = await ensureSourceControlProxyPort();
  const targets = buildProxyTargets(proxyCredentials);

  sourceControlProxyTargets = new Map(
    targets.map((target) => [target.key, target]),
  );
  writeSourceControlProxyGitConfig(targets, port);
}

export async function applySourceControlTokenMetadata(
  sourceControlToken?: Pick<
    SourceControlTokenMetadata,
    'envVars' | 'gitCredentials' | 'gitProxyCredentials'
  > | null,
): Promise<void> {
  const envVars = sourceControlToken?.envVars ?? {};

  for (const envVar of getSourceControlTokenEnvVars()) {
    const token = envVars[envVar];

    if (token) {
      writeSourceControlToken(envVar, token);
    } else {
      clearSourceControlToken(envVar);
    }
  }

  const repositoryCredentials =
    sourceControlToken?.gitCredentials?.filter(
      (credential) =>
        credential.host.trim().length > 0 &&
        credential.repositoryFullName.trim().length > 0 &&
        credential.username.trim().length > 0 &&
        credential.token.trim().length > 0,
    ) ?? [];

  if (repositoryCredentials.length > 0) {
    writeSourceControlRepositoryCredentials(repositoryCredentials);
  } else {
    clearSourceControlRepositoryCredentials();
  }

  const proxyCredentials =
    sourceControlToken?.gitProxyCredentials?.filter(
      (credential) =>
        credential.host.trim().length > 0 &&
        credential.repositoryFullName.trim().length > 0 &&
        credential.username.trim().length > 0 &&
        credential.token.trim().length > 0,
    ) ?? [];

  await applySourceControlProxyCredentials(proxyCredentials);
}

function ensureGhTokenDirectory(): void {
  mkdirSync(GH_TOKEN_DIR, { recursive: true, mode: 0o700 });
  chmodSync(GH_TOKEN_DIR, 0o700);
}
