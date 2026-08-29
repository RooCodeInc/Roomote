import {
  db,
  deploymentSettings,
  environments,
  environmentRepositoryMappings,
  deploymentMcpEnablements,
  repositories,
  users,
  asc,
  eq,
  inArray,
  invalidateBrainEnabledCache,
  sql,
} from '@roomote/db/server';
import {
  TaskPayloadKind,
  type EnvironmentConfig,
  normalizeSetupNewState,
} from '@roomote/types';
import {
  requestBrainBackfill,
  requestInstancePing,
} from '@roomote/sdk/server/request-instance-ping';
import {
  captureActivationEnvironmentSaved,
  captureActivationSetupCompleted,
  captureEvent,
} from '@roomote/telemetry/server';
import { ANONYMOUS_ANALYTICS_METADATA_KEY } from '@roomote/feature-flags';
import {
  AVAILABLE_SETUP_MCP_INTEGRATIONS,
  enqueueTask,
  normalizeEnabledSetupMcpIntegrationIds,
  type CurrentMcpConfig,
} from '@roomote/cloud-agents/server';

import type { UserAuthSuccess } from '@/types';
import { findMatchingSetupNewEnvironment } from '@/lib/setup-new';
import {
  assertAdmin,
  ensureDefaultSetupAgents,
  getSetupBaseStatus,
} from './shared';
import { ensureManagedReviewerEnabledByDefaultInTx } from '../automations';
import { Env, isRoomoteCloudEnabled } from '@/lib/server/env';
import { subscribeToProductUpdates } from '@/lib/server/product-updates';

// --- Mutations ---

export async function batchCreateEnvironmentsCommand(
  auth: UserAuthSuccess,
  input: {
    environments: Array<{
      name: string;
      repositoryIds: string[];
      installCommand?: string;
      testCommand?: string;
    }>;
  },
) {
  assertAdmin(auth);
  const { userId } = auth;

  if (
    input.environments.length === 0 ||
    input.environments.every(
      (environment) => environment.repositoryIds.length === 0,
    )
  ) {
    throw new Error(
      'At least one environment with at least one repository is required',
    );
  }

  // Collect all unique repository IDs to look up in one query
  const allRepoIds = [
    ...new Set(
      input.environments.flatMap((environment) => environment.repositoryIds),
    ),
  ];

  const repos = await db
    .select({ id: repositories.id, fullName: repositories.fullName })
    .from(repositories)
    .where(inArray(repositories.id, allRepoIds));

  const repoMap = new Map(repos.map((r) => [r.id, r.fullName]));

  // Idempotency: if environments already exist for this org, skip creation
  const existingEnvs = await db
    .select({ id: environments.id })
    .from(environments)
    .where(eq(environments.isEval, false))
    .limit(1);

  if (existingEnvs.length > 0) {
    return { environmentIds: existingEnvs.map((e) => e.id) };
  }

  const result = await db.transaction(async (tx) => {
    const createdIds: string[] = [];

    for (const environmentSpec of input.environments) {
      const commands: EnvironmentConfig['repositories'][number]['commands'] =
        [];
      if (environmentSpec.installCommand) {
        commands.push({
          name: 'install',
          run: environmentSpec.installCommand,
          timeout: 600,
          continue_on_error: false,
        });
      }

      const configRepos = environmentSpec.repositoryIds
        .filter((id) => repoMap.has(id))
        .map((id) => ({
          repository: repoMap.get(id)!,
          ...(commands.length > 0 ? { commands } : {}),
        }));

      const agentInstructions = environmentSpec.testCommand
        ? `To verify your changes, run: ${environmentSpec.testCommand}\nAlways run this command after making changes and fix any issues before considering the task complete.`
        : undefined;

      const config: EnvironmentConfig = {
        name: environmentSpec.name,
        repositories: configRepos,
        ...(agentInstructions ? { agentInstructions } : {}),
      };

      const [created] = await tx
        .insert(environments)
        .values({
          name: environmentSpec.name,
          config,
          createdByUserId: userId,
          isVerified: false,
          verificationError: null,
        })
        .returning({ id: environments.id });

      if (!created) {
        throw new Error(
          `Failed to create environment: ${environmentSpec.name}`,
        );
      }

      createdIds.push(created.id);

      const mappings = environmentSpec.repositoryIds
        .filter((id) => repoMap.has(id))
        .map((repositoryId) => ({
          environmentId: created.id,
          repositoryId,
        }));

      if (mappings.length > 0) {
        await tx.insert(environmentRepositoryMappings).values(mappings);
      }
    }

    return { environmentIds: createdIds };
  });

  for (const _environmentId of result.environmentIds) {
    void captureActivationEnvironmentSaved('setup');
  }

  return result;
}

export async function autoCreateAgentsCommand(auth: UserAuthSuccess) {
  return ensureDefaultSetupAgents(auth);
}

function formatSetupMcpRecommendationCatalog(): string {
  return AVAILABLE_SETUP_MCP_INTEGRATIONS.map(
    (integration) =>
      `- ${integration.name} (\`${integration.id}\`): ${integration.description} Capabilities: ${integration.capabilities.join(
        '; ',
      )}. Setup location: ${integration.setupLocation}.`,
  ).join('\n');
}

function formatEnabledSetupMcpRecommendationIds(
  currentConfig: CurrentMcpConfig,
): string {
  const enabledIntegrationIds = normalizeEnabledSetupMcpIntegrationIds(
    currentConfig,
  ).sort((left, right) => left.localeCompare(right));

  if (enabledIntegrationIds.length === 0) {
    return '- none';
  }

  return enabledIntegrationIds
    .map((integrationId) => `- ${integrationId}`)
    .join('\n');
}

function buildSetupCompletionMcpRecommendationsPrompt(params: {
  repositoryFullNames: string[];
  currentConfig: CurrentMcpConfig;
}): string {
  const repositoryLines = params.repositoryFullNames
    .map((repositoryFullName) => `- ${repositoryFullName}`)
    .join('\n');

  return `You are running inside a Roomote environment with the selected codebase already checked out on disk.

Selected repositories:
${repositoryLines}

Available Roomote integrations:
${formatSetupMcpRecommendationCatalog()}

Already enabled or configured integrations:
${formatEnabledSetupMcpRecommendationIds(params.currentConfig)}

Your job:
- Explore the codebase directly from the filesystem to understand which services, tools, platforms, and workflows this team uses.
- Inspect manifests, lockfiles, env/example files, CI/workflows, infra/config files, README/docs, and relevant source imports before deciding.
- Recommend only integrations from the catalog above.
- Do not recommend anything that is already enabled or configured.
- Prefer high-confidence recommendations grounded in concrete repository evidence.
- If nothing else should be recommended, submit an empty list.

When you are ready, submit the final result with an authenticated POST request to:
\`${'${ROOMOTE_PLATFORM_API_URL:-$TRPC_URL}'}/api/mcp/tasks/$ROOMOTE_TASK_ID/mcp_recommendations\`

Always include:
- \`Authorization: Bearer $ROOMOTE_CLOUD_TOKEN\`
- \`Content-Type: application/json\`
- If \`ROOMOTE_AUTH_BYPASS_VALUE\` is set, also include \`${'${ROOMOTE_AUTH_BYPASS_HEADER_NAME:-x-roomote-auth-bypass}'}: $ROOMOTE_AUTH_BYPASS_VALUE\`

Submit JSON in this shape:
\`\`\`json
{
  "recommendations": [
    {
      "id": "posthog",
      "rationale": "This repo already uses PostHog for product analytics, so enabling the integration would let Roomote inspect flags, funnels, and experiment context directly."
    }
  ]
}
\`\`\`

Each rationale must be exactly one sentence explaining why that integration would help based on what you found in the codebase.

After you submit the recommendations, stop.`;
}

async function getSetupCompletionMcpRecommendationContext(
  auth: UserAuthSuccess,
): Promise<{
  sourceTaskId: string;
  slackTeamId: string | null;
  slackChannel: string;
  environmentId: string;
  repositoryFullNames: string[];
  currentConfig: {
    enabledIntegrationIds: string[];
    configuredCustomServerIds: string[];
  };
} | null> {
  const baseStatus = await getSetupBaseStatus(auth);
  const setupNewState = normalizeSetupNewState(baseStatus.setupNewState);

  if (
    !setupNewState.onboardingTaskId ||
    !setupNewState.onboardingTaskStartedAt ||
    !setupNewState.slackChannel ||
    setupNewState.selectedRepositoryIds.length === 0
  ) {
    return null;
  }

  const [selectedRepositories, environmentList, enabledDeploymentMcpRows] =
    await Promise.all([
      db
        .select({
          id: repositories.id,
          fullName: repositories.fullName,
        })
        .from(repositories)
        .where(inArray(repositories.id, setupNewState.selectedRepositoryIds))
        .orderBy(asc(repositories.fullName)),
      db.query.environments.findMany({
        where: eq(environments.isEval, false),
        columns: {
          id: true,
          name: true,
          config: true,
          createdAt: true,
        },
      }),
      db.query.deploymentMcpEnablements.findMany({
        where: eq(deploymentMcpEnablements.enabled, true),
        columns: {
          mcpId: true,
        },
      }),
    ]);

  const repositoriesById = new Map(
    selectedRepositories.map((repository) => [repository.id, repository]),
  );
  const repositoryFullNames = setupNewState.selectedRepositoryIds
    .map((repositoryId) => repositoriesById.get(repositoryId)?.fullName ?? null)
    .filter((repositoryFullName): repositoryFullName is string =>
      Boolean(repositoryFullName),
    );

  if (repositoryFullNames.length === 0) {
    return null;
  }

  const matchingEnvironment = findMatchingSetupNewEnvironment(
    environmentList,
    repositoryFullNames,
    setupNewState.onboardingTaskStartedAt,
  );

  if (!matchingEnvironment) {
    return null;
  }

  // Environment-scoped custom servers plus deployment-wide custom servers:
  // both mean "this service is already wired", so the setup agent should not
  // recommend configuring it again.
  const deploymentCustomServers = await db.query.customMcpServers.findMany({
    where: (table, { eq: whereEq }) => whereEq(table.enabled, true),
    columns: { name: true },
  });
  const configuredCustomServerIds = [
    ...Object.keys(
      (matchingEnvironment.config as EnvironmentConfig).mcpServers ?? {},
    ),
    ...deploymentCustomServers.map(({ name }) => name),
  ];
  const enabledIntegrationIds = [
    ...new Set([
      ...enabledDeploymentMcpRows.map(({ mcpId }) => mcpId),
      ...(baseStatus.hasGitHub ? ['github'] : []),
      ...(baseStatus.hasSlack ? ['slack'] : []),
      ...(baseStatus.hasLinear ? ['linear'] : []),
    ]),
  ];

  return {
    sourceTaskId: setupNewState.onboardingTaskId,
    slackTeamId: setupNewState.slackTeamId,
    slackChannel: setupNewState.slackChannel,
    environmentId: matchingEnvironment.id,
    repositoryFullNames,
    currentConfig: {
      enabledIntegrationIds,
      configuredCustomServerIds,
    },
  };
}

async function sendSetupCompletionMcpRecommendations(
  auth: UserAuthSuccess,
): Promise<void> {
  const { userId } = auth;

  try {
    const mcpRecommendationContext =
      await getSetupCompletionMcpRecommendationContext(auth);

    if (!mcpRecommendationContext) {
      return;
    }

    const primaryRepository = mcpRecommendationContext.repositoryFullNames[0];

    if (!primaryRepository) {
      return;
    }

    await enqueueTask({
      task: {
        type: TaskPayloadKind.McpRecommendations,
        payload: {
          repo: primaryRepository,
          environmentId: mcpRecommendationContext.environmentId,
          description: buildSetupCompletionMcpRecommendationsPrompt({
            repositoryFullNames: mcpRecommendationContext.repositoryFullNames,
            currentConfig: mcpRecommendationContext.currentConfig,
          }),
          sourceTaskId: mcpRecommendationContext.sourceTaskId,
          ...(mcpRecommendationContext.slackTeamId
            ? { teamId: mcpRecommendationContext.slackTeamId }
            : {}),
          slackChannel: mcpRecommendationContext.slackChannel,
          installerUserId: userId,
          currentConfig: mcpRecommendationContext.currentConfig,
          visibleInTranscript: false,
        },
      },
      initiator: { kind: 'automation', key: 'mcp_recommendations' },
      workflow: 'mcp_recommendations',
      surface: 'web',
      trigger: 'manual',
      visibility: 'hidden',
    });
  } catch (error) {
    console.error(
      `[completeSetupCommand] Failed to enqueue MCP recommendations task: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

export async function completeSetupCommand(
  auth: UserAuthSuccess,
  input?: {
    anonymousAnalyticsEnabled?: boolean;
    productUpdatesEnabled?: boolean;
  },
) {
  assertAdmin(auth);
  const { userId } = auth;

  const now = new Date();

  const defaultedBrainEnabled = await db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext('setup-complete'))`,
    );

    // Persist the StepInvoke anonymous-analytics choice alongside setup
    // completion when the wizard provided one (opt-out: default stays
    // enabled when the field is absent).
    const existingSettings = await tx.query.deploymentSettings.findFirst({
      where: eq(deploymentSettings.id, 'default'),
      columns: {
        metadata: true,
        setupNewState: true,
        setupCompletedAt: true,
        brainEnabled: true,
      },
    });
    const recommendationsWereReviewed =
      normalizeSetupNewState(existingSettings?.setupNewState ?? {})
        .automationRecommendations?.status === 'ready';
    let metadataUpdate: Record<string, unknown> | undefined;
    const cloudEnabled = isRoomoteCloudEnabled(Env.R_CLOUD_ENABLED);
    const anonymousAnalyticsEnabled = cloudEnabled
      ? true
      : input?.anonymousAnalyticsEnabled;
    // Setup completion is the shared creation boundary. Default only unfinished
    // Cloud deployments so existing instances and explicit choices stay intact.
    const brainEnabledDefault =
      cloudEnabled &&
      existingSettings?.setupCompletedAt == null &&
      existingSettings?.brainEnabled == null
        ? true
        : undefined;
    if (anonymousAnalyticsEnabled !== undefined) {
      const existingMetadata =
        existingSettings?.metadata &&
        typeof existingSettings.metadata === 'object' &&
        !Array.isArray(existingSettings.metadata)
          ? { ...(existingSettings.metadata as Record<string, unknown>) }
          : {};
      metadataUpdate = {
        ...existingMetadata,
        [ANONYMOUS_ANALYTICS_METADATA_KEY]: anonymousAnalyticsEnabled,
      };
    }

    await Promise.all([
      tx
        .insert(deploymentSettings)
        .values({
          id: 'default',
          setupCompletedAt: now,
          ...(metadataUpdate ? { metadata: metadataUpdate } : {}),
          ...(brainEnabledDefault === undefined
            ? {}
            : { brainEnabled: brainEnabledDefault }),
        })
        .onConflictDoUpdate({
          target: deploymentSettings.id,
          set: {
            setupCompletedAt: now,
            updatedAt: now,
            ...(metadataUpdate ? { metadata: metadataUpdate } : {}),
            // Evaluate under the conflict row lock so a concurrent explicit
            // Memory choice wins over this setup default.
            ...(brainEnabledDefault === undefined
              ? {}
              : {
                  brainEnabled: sql`coalesce(${deploymentSettings.brainEnabled}, ${brainEnabledDefault})`,
                }),
          },
        }),
      // The first admin going through /setup should not also need /onboarding,
      // so mark their onboarding as completed at the same time.
      tx
        .update(users)
        .set({ onboardingCompletedAt: now })
        .where(eq(users.id, userId)),
    ]);

    if (!recommendationsWereReviewed) {
      await ensureManagedReviewerEnabledByDefaultInTx(tx, auth);
    }

    return brainEnabledDefault === true;
  });

  if (defaultedBrainEnabled) {
    invalidateBrainEnabledCache();
  }

  // Setup completion should not wait for the GitHub-backed recommendation scan.
  queueMicrotask(() => {
    void sendSetupCompletionMcpRecommendations(auth);
  });

  void captureEvent('setup_completed', { userId });
  void captureActivationSetupCompleted();

  // Refresh the anonymous instance report now that setup is complete, so the
  // Ping service sees the founding admin within minutes instead of at the
  // next daily tick.
  void requestInstancePing('setup-completed');

  // Sources typically get connected during setup, and no toggle fires
  // afterwards — kick the initial Memory backfill now so a fresh deployment's
  // brain starts filling the moment setup finishes. No-ops harmlessly when
  // Memory is off; the jobs hold their checkpoints.
  void requestBrainBackfill('setup-completed');

  if (
    (input?.productUpdatesEnabled ?? true) &&
    !(auth.cloudEnabled && auth.isAdmin)
  ) {
    void subscribeToProductUpdates(auth.primaryEmail, 'setup');
  }

  return { success: true as const };
}

// --- Queries ---

export async function getSetupStatusCommand(auth: UserAuthSuccess) {
  const { setupNewState: _setupNewState, ...setupStatus } =
    await getSetupBaseStatus(auth);
  return setupStatus;
}
