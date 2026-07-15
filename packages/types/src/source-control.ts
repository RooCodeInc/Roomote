import { z } from 'zod';

export const sourceControlProviders = [
  'github',
  'gitlab',
  'gitea',
  'ado',
  'bitbucket',
] as const;

export const sourceControlProviderSchema = z.enum(sourceControlProviders);

export type SourceControlProvider = z.infer<typeof sourceControlProviderSchema>;
export type SourceControlTokenBackedProvider = Exclude<
  SourceControlProvider,
  'github'
>;
export type SourceControlConnectionMode = 'app' | 'token';

export type SourceControlTokenEnvVar =
  | 'GH_TOKEN'
  | 'GITLAB_TOKEN'
  | 'GITEA_TOKEN'
  | 'ADO_TOKEN'
  | 'BITBUCKET_OAUTH';

export type SourceControlGitCredential = {
  host: string;
  repositoryFullName: string;
  username: string;
  token: string;
  authScheme?: 'basic' | 'bearer';
  originBaseUrl?: string;
};

export type SourceControlProxyCredential = SourceControlGitCredential & {
  provider: SourceControlProvider;
};

export type SourceControlTokenMetadata = {
  provider: SourceControlProvider;
  token: string;
  envVar: SourceControlTokenEnvVar;
  envVars: Partial<Record<SourceControlTokenEnvVar, string>>;
  gitCredentials?: SourceControlGitCredential[];
  gitProxyCredentials?: SourceControlProxyCredential[];
};

export type SourceControlPullRequestRef = {
  provider: SourceControlProvider;
  host?: string;
  repositoryFullName: string;
  number: number;
};

export type SourceControlRepositoryRef = {
  provider: SourceControlProvider;
  host?: string;
  repositoryFullName: string;
};

export const DEFAULT_SOURCE_CONTROL_PROVIDER: SourceControlProvider = 'github';

export const sourceControlProviderDescriptors = {
  github: {
    provider: 'github',
    label: 'GitHub',
    defaultHost: 'github.com',
    tokenEnvVar: 'GH_TOKEN',
    connectionMode: 'app',
  },
  gitlab: {
    provider: 'gitlab',
    label: 'GitLab',
    defaultHost: 'gitlab.com',
    tokenEnvVar: 'GITLAB_TOKEN',
    connectionMode: 'token',
  },
  gitea: {
    provider: 'gitea',
    label: 'Gitea',
    defaultHost: 'gitea.com',
    tokenEnvVar: 'GITEA_TOKEN',
    connectionMode: 'token',
  },
  ado: {
    provider: 'ado',
    label: 'Azure DevOps',
    defaultHost: 'dev.azure.com',
    tokenEnvVar: 'ADO_TOKEN',
    connectionMode: 'token',
  },
  bitbucket: {
    provider: 'bitbucket',
    label: 'Bitbucket',
    defaultHost: 'bitbucket.org',
    tokenEnvVar: 'BITBUCKET_OAUTH',
    connectionMode: 'token',
  },
} as const satisfies Record<
  SourceControlProvider,
  {
    provider: SourceControlProvider;
    label: string;
    defaultHost: string;
    tokenEnvVar: SourceControlTokenEnvVar;
    connectionMode: SourceControlConnectionMode;
  }
>;

export const sourceControlTokenBackedProviders = sourceControlProviders.filter(
  (provider): provider is SourceControlTokenBackedProvider =>
    sourceControlProviderDescriptors[provider].connectionMode === 'token',
);

export const sourceControlTokenBackedProviderSchema = z.enum(
  sourceControlTokenBackedProviders as [
    SourceControlTokenBackedProvider,
    ...SourceControlTokenBackedProvider[],
  ],
);

export function normalizeSourceControlProvider(
  provider: unknown,
): SourceControlProvider {
  if (provider === undefined || provider === null || provider === '') {
    return DEFAULT_SOURCE_CONTROL_PROVIDER;
  }

  const parsed = sourceControlProviderSchema.safeParse(provider);

  if (parsed.success) {
    return parsed.data;
  }

  throw new Error(`Unsupported source control provider: ${String(provider)}`);
}

export function resolveSourceControlProviderFromPayload(payload: {
  sourceControlProvider?: unknown;
}): SourceControlProvider {
  return normalizeSourceControlProvider(payload.sourceControlProvider);
}

/**
 * Reads the optional `sourceControlHost` field from a task payload. Returns
 * the trimmed host, or undefined when the payload carries no usable host so
 * repository resolution falls back to (provider, fullName) alone.
 */
export function resolveSourceControlHostFromPayload(payload: {
  sourceControlHost?: unknown;
}): string | undefined {
  const host =
    typeof payload.sourceControlHost === 'string'
      ? payload.sourceControlHost.trim()
      : '';
  return host || undefined;
}

export function getSourceControlProviderLabel(
  provider: SourceControlProvider,
): string {
  return sourceControlProviderDescriptors[provider].label;
}

export function getSourceControlTokenEnvVar(
  provider: SourceControlProvider,
): SourceControlTokenEnvVar {
  return sourceControlProviderDescriptors[provider].tokenEnvVar;
}

export function isSourceControlTokenBackedProvider(
  provider: SourceControlProvider,
): provider is SourceControlTokenBackedProvider {
  return sourceControlProviderDescriptors[provider].connectionMode === 'token';
}

export function getSourceControlTokenEnvVars(): SourceControlTokenEnvVar[] {
  return sourceControlProviders.map((provider) =>
    getSourceControlTokenEnvVar(provider),
  );
}

export function buildSourceControlTokenMetadata(
  provider: SourceControlProvider,
  token: string,
): SourceControlTokenMetadata {
  const envVar = getSourceControlTokenEnvVar(provider);

  return {
    provider,
    token,
    envVar,
    envVars: { [envVar]: token },
  };
}

export function buildPullRequestUrl({
  provider,
  host = sourceControlProviderDescriptors[provider].defaultHost,
  repositoryFullName,
  number,
}: SourceControlPullRequestRef): string {
  switch (provider) {
    case 'github':
      return `https://${host}/${repositoryFullName}/pull/${number}`;
    case 'gitlab':
      return `https://${host}/${repositoryFullName}/-/merge_requests/${number}`;
    case 'gitea':
      return `https://${host}/${repositoryFullName}/pulls/${number}`;
    case 'bitbucket':
      return `https://${host}/${repositoryFullName}/pull-requests/${number}`;
    case 'ado': {
      const [organization, project, ...repositoryParts] =
        repositoryFullName.split('/');
      const repository = repositoryParts.join('/');

      return `https://${host}/${encodePathSegment(
        organization,
      )}/${encodePathSegment(project)}/_git/${encodePathSegment(
        repository,
      )}/pullrequest/${number}`;
    }
  }
}

export function buildRepositoryCloneUrl({
  provider,
  host = sourceControlProviderDescriptors[provider].defaultHost,
  repositoryFullName,
}: SourceControlRepositoryRef): string {
  if (provider === 'ado') {
    const [organization, project, ...repositoryParts] =
      repositoryFullName.split('/');
    const repository = repositoryParts.join('/');

    return `https://${host}/${encodePathSegment(
      organization,
    )}/${encodePathSegment(project)}/_git/${encodePathSegment(repository)}`;
  }

  return `https://${host}/${repositoryFullName}.git`;
}

/**
 * Strips userinfo (username/password) from a clone URL. Azure DevOps
 * remote URLs embed the organization as the URL username
 * (https://org@dev.azure.com/...), which breaks git insteadOf prefix
 * rewrites and must never carry credentials — those come from the
 * worker credential helper or local proxy instead.
 */
export function stripCloneUrlUserInfo(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);
    url.username = '';
    url.password = '';

    return url.toString();
  } catch {
    return rawUrl;
  }
}

function encodePathSegment(segment: string | undefined): string {
  return encodeURIComponent(segment ?? '');
}

function decodePathSegment(segment: string): string {
  return decodeURIComponent(segment);
}

export function parsePullRequestUrl(
  url: string,
): SourceControlPullRequestRef | null {
  let parsed: URL;

  try {
    parsed = new URL(url);
  } catch {
    return null;
  }

  const pathParts = parsed.pathname.split('/').filter(Boolean);

  if (parsed.hostname === 'github.com') {
    const pullIndex = pathParts.indexOf('pull');

    if (pullIndex < 2) {
      return null;
    }

    const number = Number(pathParts[pullIndex + 1]);

    if (!Number.isInteger(number)) {
      return null;
    }

    return {
      provider: 'github',
      host: parsed.hostname,
      repositoryFullName: pathParts.slice(0, pullIndex).join('/'),
      number,
    };
  }

  // GitLab merge-request URLs use a `/-/merge_requests/<n>` marker after the
  // project path. Detect that structurally so self-managed GitLab hosts (not
  // just gitlab.com) are recognized.
  const gitLabSeparatorIndex = pathParts.indexOf('-');
  const gitLabMergeRequestsIndex = pathParts.indexOf('merge_requests');

  if (
    gitLabSeparatorIndex >= 1 &&
    gitLabMergeRequestsIndex === gitLabSeparatorIndex + 1 &&
    gitLabMergeRequestsIndex + 1 < pathParts.length
  ) {
    const number = Number(pathParts[gitLabMergeRequestsIndex + 1]);

    if (!Number.isInteger(number)) {
      return null;
    }

    return {
      provider: 'gitlab',
      host: parsed.hostname,
      repositoryFullName: pathParts.slice(0, gitLabSeparatorIndex).join('/'),
      number,
    };
  }

  const pullsIndex = pathParts.indexOf('pulls');

  if (pullsIndex >= 2 && pullsIndex + 1 < pathParts.length) {
    const number = Number(pathParts[pullsIndex + 1]);

    if (!Number.isInteger(number)) {
      return null;
    }

    return {
      provider: 'gitea',
      host: parsed.hostname,
      repositoryFullName: pathParts.slice(0, pullsIndex).join('/'),
      number,
    };
  }

  const pullRequestsIndex = pathParts.indexOf('pull-requests');

  if (pullRequestsIndex >= 2 && pullRequestsIndex + 1 < pathParts.length) {
    const number = Number(pathParts[pullRequestsIndex + 1]);

    if (!Number.isInteger(number)) {
      return null;
    }

    return {
      provider: 'bitbucket',
      host: parsed.hostname,
      repositoryFullName: pathParts.slice(0, pullRequestsIndex).join('/'),
      number,
    };
  }

  const gitIndex = pathParts.indexOf('_git');
  const pullRequestIndex = pathParts.indexOf('pullrequest');

  if (
    gitIndex === 2 &&
    pullRequestIndex === gitIndex + 2 &&
    pullRequestIndex + 1 < pathParts.length
  ) {
    const organization = pathParts[0];
    const project = pathParts[1];
    const repository = pathParts[gitIndex + 1];
    const number = Number(pathParts[pullRequestIndex + 1]);

    if (!organization || !project || !repository || !Number.isInteger(number)) {
      return null;
    }

    return {
      provider: 'ado',
      host: parsed.hostname,
      repositoryFullName: [organization, project, repository]
        .map(decodePathSegment)
        .join('/'),
      number,
    };
  }

  return null;
}
