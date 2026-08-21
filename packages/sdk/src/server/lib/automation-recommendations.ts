import { getInstallationOctokit } from '@roomote/github';
import { getLatestAdoBuild, resolveAdoInstanceHost } from '@roomote/ado';
import {
  getBitbucketPipelineResultName,
  getLatestBitbucketPipeline,
  resolveBitbucketInstanceHost,
} from '@roomote/bitbucket';
import {
  getGiteaActionRunConclusion,
  getLatestGiteaActionRun,
  isGiteaActionRunFailed,
  resolveGiteaInstanceHost,
} from '@roomote/gitea';
import {
  getLatestGitLabPipeline,
  resolveGitLabInstanceHost,
} from '@roomote/gitlab';
import {
  type AutomationRecommendationBatch,
  type RepositoryAutomationSignals,
  type SourceControlProvider,
} from '@roomote/types';
import {
  db,
  githubInstallations,
  pullRequestFacts,
  repositories,
  repositoryAutomationSignals,
  and,
  eq,
  gte,
  inArray,
} from '@roomote/db/server';
import {
  AUTOMATION_SIGNALS_VERSION,
  automationRecommendationJobSchema,
  automationSignalPrefetchJobSchema,
  type AutomationRecommendationJob,
  type AutomationSignalPrefetchJob,
} from './automation-recommendation-queues';
export {
  AUTOMATION_RECOMMENDATIONS_QUEUE_NAME,
  AUTOMATION_RECOMMENDATION_INITIAL_RUN_QUEUE_NAME,
  AUTOMATION_RECOMMENDATION_REPOSITORY_CAP,
  AUTOMATION_SIGNAL_PREFETCH_QUEUE_NAME,
  AUTOMATION_SIGNALS_VERSION,
  automationRecommendationInitialRunJobSchema,
  automationRecommendationJobSchema,
  automationSignalPrefetchJobSchema,
  buildAutomationRecommendationFingerprint,
  enqueueAutomationRecommendationInitialRun,
  enqueueAutomationRecommendations,
  enqueueAutomationSignalPrefetch,
  type AutomationRecommendationInitialRunJob,
  type AutomationRecommendationJob,
  type AutomationSignalPrefetchJob,
} from './automation-recommendation-queues';
import {
  AUTOMATION_RECOMMENDATIONS_CATALOG_VERSION,
  AUTOMATION_RECOMMENDATION_CATALOG,
  scoreAutomationRecommendations,
} from './automation-recommendations-policy';
import {
  isSetupAutomationRecommendationFingerprintCurrent,
  updateSetupAutomationRecommendationBatchIfCurrent,
} from './setup-automation-recommendations';

const AUTOMATION_SIGNAL_LOOKBACK_MS = 30 * 24 * 60 * 60 * 1000;
const DEPENDENCY_MANIFEST_NAMES = new Set([
  'bun.lock',
  'bun.lockb',
  'cargo.lock',
  'composer.json',
  'composer.lock',
  'gemfile',
  'gemfile.lock',
  'go.mod',
  'go.sum',
  'package-lock.json',
  'package.json',
  'pipfile',
  'pipfile.lock',
  'poetry.lock',
  'pnpm-lock.yaml',
  'pyproject.toml',
  'requirements.txt',
  'cargo.toml',
  'yarn.lock',
]);

type GitHubOctokit = Awaited<ReturnType<typeof getInstallationOctokit>>;
type GitHubOctokitCache = Map<string, Promise<GitHubOctokit>>;

async function getCachedGitHubOctokit(
  installationId: string,
  cache: GitHubOctokitCache,
): Promise<GitHubOctokit> {
  const existing = cache.get(installationId);
  if (existing) return existing;

  const client = db
    .select({ installationId: githubInstallations.installationId })
    .from(githubInstallations)
    .where(eq(githubInstallations.id, installationId))
    .limit(1)
    .then(async ([installation]) => {
      if (!installation) {
        throw new Error(`GitHub installation ${installationId} was not found.`);
      }

      return getInstallationOctokit(installation);
    });
  cache.set(installationId, client);
  return client;
}

function getGitHubRepositoryParts(fullName: string): {
  owner: string;
  repo: string;
} | null {
  const [owner, repo] = fullName.split('/');
  return owner && repo ? { owner, repo } : null;
}

async function collectGitHubSignals(
  repository: {
    fullName: string;
    defaultBranch: string;
    installationId: string | null;
  },
  cache: GitHubOctokitCache,
): Promise<
  Pick<
    RepositoryAutomationSignals,
    | 'ciFailures30d'
    | 'dependabotAlerts'
    | 'codeqlAlerts'
    | 'dependencyManifests'
    | 'conflicts'
    | 'partial'
  >
> {
  const repositoryParts = getGitHubRepositoryParts(repository.fullName);
  if (!repositoryParts || !repository.installationId) {
    return {
      ciFailures30d: 0,
      dependabotAlerts: 0,
      codeqlAlerts: 0,
      dependencyManifests: 0,
      conflicts: 0,
      partial: true,
    };
  }

  let octokit: GitHubOctokit;
  try {
    octokit = await getCachedGitHubOctokit(repository.installationId, cache);
  } catch (error) {
    console.warn(
      `[automation-recommendations] Failed to authenticate GitHub signal collection for ${repository.fullName}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return {
      ciFailures30d: 0,
      dependabotAlerts: 0,
      codeqlAlerts: 0,
      dependencyManifests: 0,
      conflicts: 0,
      partial: true,
    };
  }
  const { owner, repo } = repositoryParts;
  const created = new Date(Date.now() - AUTOMATION_SIGNAL_LOOKBACK_MS)
    .toISOString()
    .slice(0, 10);
  const branch = repository.defaultBranch.replace(/^refs\/heads\//, '');
  const results = await Promise.allSettled([
    octokit.rest.actions.listWorkflowRunsForRepo({
      owner,
      repo,
      branch,
      status: 'completed',
      created: `>=${created}`,
      per_page: 100,
    }),
    octokit.rest.dependabot.listAlertsForRepo({
      owner,
      repo,
      state: 'open',
      per_page: 100,
    }),
    octokit.rest.codeScanning.listAlertsForRepo({
      owner,
      repo,
      state: 'open',
      per_page: 100,
    }),
    octokit.rest.pulls.list({
      owner,
      repo,
      state: 'open',
      per_page: 25,
    }),
    octokit.rest.repos.getContent({
      owner,
      repo,
      path: '',
      ref: branch,
    }),
  ]);

  const [
    ciRuns,
    dependabotAlerts,
    codeqlAlerts,
    openPullRequests,
    rootContents,
  ] = results;
  const failedRunCount =
    ciRuns.status === 'fulfilled'
      ? ciRuns.value.data.workflow_runs.filter(
          (run) => run.conclusion === 'failure',
        ).length
      : 0;
  const dependabotAlertCount =
    dependabotAlerts.status === 'fulfilled'
      ? dependabotAlerts.value.data.length
      : 0;
  const codeqlAlertCount =
    codeqlAlerts.status === 'fulfilled' ? codeqlAlerts.value.data.length : 0;
  const pullRequestDetails =
    openPullRequests.status === 'fulfilled'
      ? await Promise.allSettled(
          openPullRequests.value.data.map((pullRequest) =>
            octokit.rest.pulls.get({
              owner,
              repo,
              pull_number: pullRequest.number,
            }),
          ),
        )
      : [];
  const conflicts = pullRequestDetails.filter(
    (result) =>
      result.status === 'fulfilled' &&
      (result.value.data.mergeable === false ||
        result.value.data.mergeable_state === 'dirty'),
  ).length;
  const dependencyManifests =
    rootContents.status === 'fulfilled' &&
    Array.isArray(rootContents.value.data)
      ? rootContents.value.data.some(
          (entry) =>
            entry.type === 'file' &&
            DEPENDENCY_MANIFEST_NAMES.has(entry.name.toLowerCase()),
        )
        ? 1
        : 0
      : 0;

  for (const [name, result] of [
    ['CI failures', ciRuns],
    ['Dependabot alerts', dependabotAlerts],
    ['CodeQL alerts', codeqlAlerts],
    ['open pull requests', openPullRequests],
    ['dependency manifests', rootContents],
  ] as const) {
    if (result.status === 'rejected') {
      console.warn(
        `[automation-recommendations] Failed to collect ${name} for ${repository.fullName}: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`,
      );
    }
  }

  return {
    ciFailures30d: Math.min(failedRunCount, 20),
    dependabotAlerts: Math.min(dependabotAlertCount, 20),
    codeqlAlerts: Math.min(codeqlAlertCount, 20),
    dependencyManifests,
    conflicts,
    partial:
      results.some((result) => result.status === 'rejected') ||
      pullRequestDetails.some((result) => result.status === 'rejected'),
  };
}

type CiSignalRepository = {
  fullName: string;
  sourceControlProvider: RepositoryAutomationSignals['sourceControlProvider'];
  host: string | null;
  externalRepoId: string | null;
  defaultBranch: string;
};

type SignalCollectionOptions = {
  collectProviderSignals?: boolean;
};

function matchesConfiguredHost(
  repositoryHost: string | null,
  configuredHost: string,
): boolean {
  return repositoryHost?.trim().toLowerCase() === configuredHost;
}

async function collectNonGitHubCiSignal(
  repository: CiSignalRepository,
): Promise<Pick<RepositoryAutomationSignals, 'ciFailures30d' | 'partial'>> {
  const branch = repository.defaultBranch.replace(/^refs\/heads\//, '');

  if (!repository.externalRepoId) {
    return { ciFailures30d: 0, partial: true };
  }

  switch (repository.sourceControlProvider) {
    case 'gitlab': {
      const host = await resolveGitLabInstanceHost();
      if (!matchesConfiguredHost(repository.host, host)) {
        return { ciFailures30d: 0, partial: true };
      }
      const pipeline = await getLatestGitLabPipeline({
        projectId: repository.externalRepoId,
        ref: branch,
      });
      return {
        ciFailures30d: pipeline?.status.toLowerCase() === 'failed' ? 1 : 0,
        partial: false,
      };
    }
    case 'ado': {
      const host = await resolveAdoInstanceHost();
      if (!matchesConfiguredHost(repository.host, host)) {
        return { ciFailures30d: 0, partial: true };
      }
      const build = await getLatestAdoBuild({
        repositoryFullName: repository.fullName,
        repositoryId: repository.externalRepoId,
        branch,
      });
      return {
        ciFailures30d: build?.result?.toLowerCase() === 'failed' ? 1 : 0,
        partial: false,
      };
    }
    case 'bitbucket': {
      const host = await resolveBitbucketInstanceHost();
      if (!matchesConfiguredHost(repository.host, host)) {
        return { ciFailures30d: 0, partial: true };
      }
      const pipeline = await getLatestBitbucketPipeline({
        repositoryFullName: repository.fullName,
        branch,
      });
      const result = pipeline ? getBitbucketPipelineResultName(pipeline) : '';
      return {
        ciFailures30d: result === 'FAILED' || result === 'ERROR' ? 1 : 0,
        partial: false,
      };
    }
    case 'gitea': {
      const host = await resolveGiteaInstanceHost();
      if (!matchesConfiguredHost(repository.host, host)) {
        return { ciFailures30d: 0, partial: true };
      }
      const run = await getLatestGiteaActionRun({
        repositoryFullName: repository.fullName,
        branch,
      });
      return {
        ciFailures30d:
          run && isGiteaActionRunFailed(getGiteaActionRunConclusion(run))
            ? 1
            : 0,
        partial: false,
      };
    }
    case 'github':
      return { ciFailures30d: 0, partial: true };
  }
}

async function collectSignals(
  repositoryId: string,
  githubOctokitCache: GitHubOctokitCache = new Map(),
  options: SignalCollectionOptions = {},
): Promise<RepositoryAutomationSignals> {
  const startedAt = Date.now();
  const [repository] = await db
    .select({
      id: repositories.id,
      fullName: repositories.fullName,
      sourceControlProvider: repositories.sourceControlProvider,
      defaultBranch: repositories.defaultBranch,
      installationId: repositories.installationId,
      host: repositories.host,
      externalRepoId: repositories.externalRepoId,
    })
    .from(repositories)
    .where(eq(repositories.id, repositoryId))
    .limit(1);

  if (!repository) throw new Error(`Repository ${repositoryId} was not found.`);

  console.info(
    `[automation-recommendations] Started signal collection for ${repository.fullName} (${repository.sourceControlProvider})`,
  );

  const facts = await db
    .select({
      state: pullRequestFacts.state,
      mergedAtRemote: pullRequestFacts.mergedAtRemote,
    })
    .from(pullRequestFacts)
    .where(eq(pullRequestFacts.repositoryId, repositoryId));
  const since = Date.now() - AUTOMATION_SIGNAL_LOOKBACK_MS;
  let providerSignals = {
    ciFailures30d: 0,
    dependabotAlerts: 0,
    codeqlAlerts: 0,
    dependencyManifests: 0,
    conflicts: 0,
    partial: true,
  };
  if (options.collectProviderSignals !== false) {
    try {
      const collected =
        repository.sourceControlProvider === 'github'
          ? await collectGitHubSignals(repository, githubOctokitCache)
          : {
              ...(await collectNonGitHubCiSignal(repository)),
              dependabotAlerts: 0,
              codeqlAlerts: 0,
              dependencyManifests: 0,
              conflicts: 0,
            };
      providerSignals = {
        ...collected,
        partial: collected.partial ?? false,
      };
    } catch (error) {
      console.warn(
        `[automation-recommendations] Failed to collect provider signals for ${repository.fullName}: ${error instanceof Error ? error.message : String(error)}`,
      );
      providerSignals = {
        ciFailures30d: 0,
        dependabotAlerts: 0,
        codeqlAlerts: 0,
        dependencyManifests: 0,
        conflicts: 0,
        partial: true,
      };
    }
  }

  const payload = {
    repositoryId: repository.id,
    repositoryName: repository.fullName,
    sourceControlProvider: repository.sourceControlProvider,
    mergedPrs30d: facts.filter(
      (fact) =>
        fact.state === 'merged' &&
        fact.mergedAtRemote &&
        fact.mergedAtRemote.getTime() >= since,
    ).length,
    openPrs: facts.filter(
      (fact) => fact.state === 'open' || fact.state === 'draft',
    ).length,
    ...providerSignals,
    docs: 0,
    partial: providerSignals.partial,
  };

  console.info(
    `[automation-recommendations] Collected signals for ${repository.fullName} in ${Date.now() - startedAt}ms`,
    {
      ciFailures30d: payload.ciFailures30d,
      dependabotAlerts: payload.dependabotAlerts,
      codeqlAlerts: payload.codeqlAlerts,
      dependencyManifests: payload.dependencyManifests,
      conflicts: payload.conflicts,
      openPrs: payload.openPrs,
      mergedPrs30d: payload.mergedPrs30d,
      partial: payload.partial,
    },
  );

  return payload;
}

export async function collectAutomationSignalsJob(
  input: AutomationSignalPrefetchJob,
): Promise<void> {
  const request = automationSignalPrefetchJobSchema.parse(input);
  const startedAt = Date.now();
  console.info(
    `[automation-recommendations] Started signal prefetch for repository ${request.repositoryId}`,
  );
  const payload = await collectSignals(request.repositoryId, new Map());
  await db
    .insert(repositoryAutomationSignals)
    .values({
      repositoryId: request.repositoryId,
      signalsVersion: request.signalsVersion,
      payload,
      partial: payload.partial ?? false,
    })
    .onConflictDoUpdate({
      target: [
        repositoryAutomationSignals.repositoryId,
        repositoryAutomationSignals.signalsVersion,
      ],
      set: {
        payload,
        partial: payload.partial ?? false,
        collectedAt: new Date(),
      },
    });
  console.info(
    `[automation-recommendations] Completed signal prefetch for repository ${request.repositoryId} in ${Date.now() - startedAt}ms`,
  );
}

function mergeRecommendationState(
  batch: AutomationRecommendationBatch,
  previous: AutomationRecommendationBatch | null,
): AutomationRecommendationBatch {
  if (!previous || previous.inputFingerprint !== batch.inputFingerprint) {
    return batch;
  }

  const applicationState =
    previous.applicationState ??
    (previous.status === 'ready' ? 'applied' : 'pending');

  return {
    ...batch,
    dismissed: previous.dismissed,
    applicationState,
    recommendations: batch.recommendations.map((recommendation) => {
      const existing = previous.recommendations.find(
        (item) => item.candidateId === recommendation.candidateId,
      );
      return existing
        ? {
            ...recommendation,
            enabled:
              applicationState === 'skipped' && existing.applied !== true
                ? false
                : existing.enabled,
            lastRunTaskId: existing.lastRunTaskId,
            automationId: existing.automationId,
            applied: existing.applied,
            initialRunClaimedAt: existing.initialRunClaimedAt,
            initialRunDispatchAttemptedAt:
              existing.initialRunDispatchAttemptedAt,
            initialRunTerminalAt: existing.initialRunTerminalAt,
          }
        : {
            ...recommendation,
            enabled:
              applicationState === 'skipped' ? false : recommendation.enabled,
          };
    }),
  };
}

async function buildRecommendationBatch(
  repositoryIds: readonly string[],
  fingerprint: string,
): Promise<AutomationRecommendationBatch> {
  const repositoriesForSelection = await db
    .select({
      id: repositories.id,
      fullName: repositories.fullName,
      sourceControlProvider: repositories.sourceControlProvider,
    })
    .from(repositories)
    .where(inArray(repositories.id, [...repositoryIds]));

  const cached = await db
    .select({ payload: repositoryAutomationSignals.payload })
    .from(repositoryAutomationSignals)
    .where(
      and(
        eq(
          repositoryAutomationSignals.signalsVersion,
          AUTOMATION_SIGNALS_VERSION,
        ),
        gte(
          repositoryAutomationSignals.collectedAt,
          new Date(Date.now() - 24 * 60 * 60 * 1_000),
        ),
        inArray(
          repositoryAutomationSignals.repositoryId,
          repositoriesForSelection.map((repository) => repository.id),
        ),
      ),
    );
  const cachedByRepositoryId = new Map(
    cached
      .map((row) => row.payload)
      .filter(
        (payload): payload is RepositoryAutomationSignals =>
          payload !== null &&
          payload !== undefined &&
          payload.repositoryId !== undefined,
      )
      .map((payload) => [payload.repositoryId, payload]),
  );

  const githubOctokitCache: GitHubOctokitCache = new Map();
  const signals = await Promise.all(
    repositoriesForSelection.map(async (repository) => {
      const existing = cachedByRepositoryId.get(repository.id);
      if (existing) {
        console.info(
          `[automation-recommendations] Using cached signals for ${repository.fullName}`,
        );
        return existing;
      }
      return collectSignals(repository.id, githubOctokitCache, {
        collectProviderSignals: false,
      });
    }),
  );

  const merged = signals.reduce(
    (result, signal) => ({
      repositoryCount: result.repositoryCount + 1,
      sourceControlProviders: [
        ...new Set([
          ...result.sourceControlProviders,
          signal.sourceControlProvider,
        ]),
      ],
      mergedPrs30d: result.mergedPrs30d + signal.mergedPrs30d,
      openPrs: result.openPrs + signal.openPrs,
      conflicts: result.conflicts + signal.conflicts,
      ciFailures30d: result.ciFailures30d + signal.ciFailures30d,
      dependabotAlerts: result.dependabotAlerts + signal.dependabotAlerts,
      codeqlAlerts: result.codeqlAlerts + signal.codeqlAlerts,
      dependencyManifests:
        result.dependencyManifests + signal.dependencyManifests,
      partial: result.partial || signal.partial === true,
      docs: result.docs + signal.docs,
    }),
    {
      repositoryCount: 0,
      sourceControlProviders: [] as SourceControlProvider[],
      mergedPrs30d: 0,
      openPrs: 0,
      conflicts: 0,
      ciFailures30d: 0,
      dependabotAlerts: 0,
      codeqlAlerts: 0,
      dependencyManifests: 0,
      partial: false,
      docs: 0,
    },
  );
  const scored = scoreAutomationRecommendations(merged, {
    catalog: AUTOMATION_RECOMMENDATION_CATALOG,
  });
  const now = new Date().toISOString();

  return {
    version: 1,
    inputFingerprint: fingerprint,
    catalogVersion: AUTOMATION_RECOMMENDATIONS_CATALOG_VERSION,
    status: 'ready',
    startedAt: now,
    completedAt: now,
    partial: signals.some((signal) => signal.partial === true),
    errorCode: null,
    dismissed: false,
    applicationState: 'pending',
    recommendations: scored.map(({ candidate, score, explanation }, index) => ({
      id: `${candidate.id}:${index + 1}`,
      candidateId: candidate.id,
      title: candidate.title,
      rank: index + 1,
      score,
      explanation,
      enabled: true,
      lastRunTaskId: null,
      automationId: null,
      applied: false,
      initialRunClaimedAt: null,
      initialRunDispatchAttemptedAt: null,
      initialRunTerminalAt: null,
    })),
  };
}

export async function processAutomationRecommendationsJob(
  input: AutomationRecommendationJob,
): Promise<void> {
  const request = automationRecommendationJobSchema.parse(input);
  const startedAt = Date.now();
  console.info(
    `[automation-recommendations] Started recommendation scoring for ${request.repositoryIds.length} repositories`,
  );
  if (
    !(await isSetupAutomationRecommendationFingerprintCurrent(
      request.fingerprint,
    ))
  ) {
    console.info(
      '[automation-recommendations] Skipped recommendation scoring because the request is stale',
    );
    return;
  }

  try {
    const batch = await buildRecommendationBatch(
      request.repositoryIds,
      request.fingerprint,
    );
    const persisted = await updateSetupAutomationRecommendationBatchIfCurrent(
      request.fingerprint,
      (current) => mergeRecommendationState(batch, current),
    );
    if (!persisted) return;
    console.info(
      `[automation-recommendations] Completed recommendation scoring for ${request.repositoryIds.length} repositories in ${Date.now() - startedAt}ms`,
      {
        recommendationCount: batch.recommendations.length,
        partial: batch.partial,
      },
    );
  } catch (error) {
    await updateSetupAutomationRecommendationBatchIfCurrent(
      request.fingerprint,
      (current) => ({
        ...current,
        status: 'failed',
        completedAt: new Date().toISOString(),
        errorCode: 'recommendation_generation_failed',
      }),
    );
    console.warn(
      `[automation-recommendations] Recommendation scoring failed after ${Date.now() - startedAt}ms`,
    );
    throw error;
  }
}
