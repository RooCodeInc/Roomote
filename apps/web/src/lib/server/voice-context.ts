import {
  getAvailableEnvironments,
  resolveApiBaseUrl,
  type RoutableEnvironment,
} from '@roomote/cloud-agents/server';
import { db, eq, repositories } from '@roomote/db/server';
import { resolveUserMcpServerConfigs } from '@roomote/sdk/server';
import {
  getMcpIntegration,
  getMemoryMcpDisplayName,
  isMemoryMcpServer,
  ROOMOTE_MCP_ID,
} from '@roomote/types';

/**
 * What the Fast session behind a voice conversation can reach. GPT-Live gets
 * this so a repository or integration name is recognised as work to delegate
 * rather than something to ask about, and the transcript cleanup gets it as
 * vocabulary so misheard names are corrected to the real ones.
 */
export type VoiceWorkspaceContext = {
  /** Every active repository, the "All repositories" launch target. */
  repositoryNames: string[];
  environments: Array<{
    name: string;
    description?: string;
    repositoryNames: string[];
  }>;
  integrationNames: string[];
};

const EMPTY_CONTEXT: VoiceWorkspaceContext = {
  repositoryNames: [],
  environments: [],
  integrationNames: [],
};

const CONTEXT_CACHE_TTL_MS = 60_000;
const contextCache = new Map<
  string,
  { value: VoiceWorkspaceContext; expiresAt: number }
>();

/** Best effort: a failed lookup degrades to an empty section, never blocks voice. */
export async function loadVoiceWorkspaceContext(
  userId: string,
): Promise<VoiceWorkspaceContext> {
  const now = Date.now();
  const cached = contextCache.get(userId);
  if (cached && cached.expiresAt > now) return cached.value;

  const [repositoryNames, environments, integrationNames] = await Promise.all([
    db
      .select({ fullName: repositories.fullName })
      .from(repositories)
      .where(eq(repositories.isActive, true))
      .orderBy(repositories.fullName)
      .then((rows) => rows.map((row) => row.fullName))
      .catch((error: unknown) => {
        console.warn(
          '[voice] Repositories unavailable for voice context',
          error,
        );
        return EMPTY_CONTEXT.repositoryNames;
      }),
    getAvailableEnvironments()
      .then((available) => available.map(toContextEnvironment))
      .catch((error: unknown) => {
        console.warn(
          '[voice] Environments unavailable for voice context',
          error,
        );
        return EMPTY_CONTEXT.environments;
      }),
    resolveUserMcpServerConfigs({
      userId,
      apiBaseUrl: resolveApiBaseUrl() ?? undefined,
      includeRoomoteMemberTools: true,
    })
      .then((servers) => Object.keys(servers).map(describeIntegration))
      .catch((error: unknown) => {
        console.warn(
          '[voice] Integrations unavailable for voice context',
          error,
        );
        return EMPTY_CONTEXT.integrationNames;
      }),
  ]);

  const value: VoiceWorkspaceContext = {
    repositoryNames,
    environments,
    integrationNames,
  };
  contextCache.set(userId, { value, expiresAt: now + CONTEXT_CACHE_TTL_MS });
  return value;
}

function toContextEnvironment(
  environment: RoutableEnvironment,
): VoiceWorkspaceContext['environments'][number] {
  return {
    name: environment.name,
    ...(environment.description
      ? { description: environment.description }
      : {}),
    repositoryNames: environment.repositoryNames,
  };
}

function describeIntegration(id: string): string {
  if (id === ROOMOTE_MCP_ID) return 'Roomote';
  if (isMemoryMcpServer(id)) return getMemoryMcpDisplayName(id);
  return getMcpIntegration(id)?.name ?? id;
}

const MAX_PROMPT_REPOSITORIES = 60;

/** Prose section for the GPT-Live instructions. */
export function formatVoiceWorkspaceContext(
  context: VoiceWorkspaceContext,
): string {
  const lines: string[] = [];

  if (context.repositoryNames.length > 0) {
    const shown = context.repositoryNames.slice(0, MAX_PROMPT_REPOSITORIES);
    const more = context.repositoryNames.length - shown.length;
    lines.push(
      `Repositories the backend can work in (it can also run against all of them at once): ${shown.join(', ')}${more > 0 ? `, and ${more} more` : ''}.`,
    );
  }

  if (context.environments.length > 0) {
    lines.push('Environments available for task routing:');
    let remaining = MAX_PROMPT_REPOSITORIES;
    for (const environment of context.environments) {
      const repos = environment.repositoryNames.slice(
        0,
        Math.max(remaining, 0),
      );
      remaining -= repos.length;
      const repoText =
        repos.length > 0
          ? repos.join(', ') +
            (environment.repositoryNames.length > repos.length
              ? ', and more'
              : '')
          : null;
      const description = environment.description
        ? ` (${environment.description})`
        : '';
      lines.push(
        `- ${environment.name}${description}${repoText ? `: ${repoText}` : ''}`,
      );
    }
  } else if (context.repositoryNames.length === 0) {
    lines.push(
      'The backend has access to the repositories and environments configured for this deployment.',
    );
  }

  if (context.integrationNames.length > 0) {
    lines.push(
      `Integrations the backend can use: ${context.integrationNames.join(', ')}.`,
    );
  }

  return lines.join('\n');
}

/** Names worth spelling correctly when cleaning a transcript. */
export function voiceContextVocabulary(
  context: VoiceWorkspaceContext,
): string[] {
  const names = new Set<string>(context.repositoryNames);
  for (const environment of context.environments) {
    names.add(environment.name);
    for (const repo of environment.repositoryNames) names.add(repo);
  }
  for (const integration of context.integrationNames) names.add(integration);
  return [...names];
}
