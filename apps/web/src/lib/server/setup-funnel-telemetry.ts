import { db, deploymentSettings, eq, sql } from '@roomote/db/server';
import {
  captureActivationSetupMilestone,
  isAnonymousAnalyticsEnabled,
} from '@roomote/telemetry/server';
import type {
  ActivationSetupMilestone,
  ActivationSetupMilestoneProperties,
} from '@roomote/telemetry';
import type {
  SetupAuthStatus,
  SetupComputeStatus,
  SetupModelStatus,
  SetupNewState,
  SetupSourceControlStatus,
} from '@roomote/types';

const METADATA_KEY = 'setup_funnel_milestones';

type SetupFunnelMilestoneInput = ActivationSetupMilestoneProperties & {
  milestone: ActivationSetupMilestone;
};

type RecordedSetupFunnelMilestone = ActivationSetupMilestoneProperties & {
  at: string;
};

type RecordedSetupFunnelMilestones = Partial<
  Record<ActivationSetupMilestone, RecordedSetupFunnelMilestone>
>;

function normalizeMetadata(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function normalizeRecordedMilestones(
  value: unknown,
): RecordedSetupFunnelMilestones {
  return normalizeMetadata(value) as RecordedSetupFunnelMilestones;
}

export function mergeSetupFunnelMilestones(
  current: RecordedSetupFunnelMilestones,
  candidates: SetupFunnelMilestoneInput[],
  recordedAt: string,
): {
  milestones: RecordedSetupFunnelMilestones;
  inserted: SetupFunnelMilestoneInput[];
} {
  const milestones = { ...current };
  const inserted: SetupFunnelMilestoneInput[] = [];

  for (const candidate of candidates) {
    if (milestones[candidate.milestone]) {
      continue;
    }

    milestones[candidate.milestone] = {
      at: recordedAt,
      ...(candidate.provider === undefined
        ? {}
        : { provider: candidate.provider }),
      ...(candidate.preexisting === undefined
        ? {}
        : { preexisting: candidate.preexisting }),
    };
    inserted.push(candidate);
  }

  return { milestones, inserted };
}

export function evaluateSetupFunnelMilestones(input: {
  setupNewState: SetupNewState;
  hasSlack: boolean;
  authSetup: SetupAuthStatus;
  modelSetup: SetupModelStatus;
  computeSetup: SetupComputeStatus;
  sourceControlSetup: SetupSourceControlStatus;
}): SetupFunnelMilestoneInput[] {
  const candidates: SetupFunnelMilestoneInput[] = [{ milestone: 'authed' }];
  const authProvider =
    input.setupNewState.authProvider ??
    input.authSetup.runtimeConfiguredProvider ??
    input.authSetup.selectedProvider ??
    input.authSetup.preselectedProvider;
  const authProviderStatus = input.authSetup.providers.find(
    (provider) => provider.id === authProvider,
  );
  const authPreexisting = input.setupNewState.authProvider === null;

  if (authProvider && authProviderStatus?.setupSatisfied) {
    candidates.push({
      milestone: 'comms_configured',
      provider: authProvider,
      preexisting: authPreexisting,
    });
  }
  if (authProvider === 'slack' && input.hasSlack) {
    candidates.push({
      milestone: 'comms_authed',
      provider: authProvider,
      preexisting: authPreexisting,
    });
  }

  const modelProvider =
    input.setupNewState.modelProvider ??
    input.modelSetup.persistedProviderId ??
    input.modelSetup.runtimeProviderId ??
    input.modelSetup.preselectedProvider;
  if (input.modelSetup.setupSatisfied) {
    candidates.push({
      milestone: 'inference_configured',
      provider: modelProvider,
      preexisting: input.setupNewState.modelProvider === null,
    });
  }

  const sourceControlProvider =
    input.setupNewState.sourceControlProvider ??
    input.sourceControlSetup.runtimeConfiguredProvider ??
    input.sourceControlSetup.connectedProvider ??
    input.sourceControlSetup.selectedProvider ??
    input.sourceControlSetup.preselectedProvider;
  const sourceControlProviderStatus = input.sourceControlSetup.providers.find(
    (provider) => provider.provider === sourceControlProvider,
  );
  const sourceControlPreexisting =
    input.setupNewState.sourceControlProvider === null;
  if (
    sourceControlProvider &&
    sourceControlProviderStatus?.configStepSatisfied
  ) {
    candidates.push({
      milestone: 'source_control_configured',
      provider: sourceControlProvider,
      preexisting: sourceControlPreexisting,
    });
  }
  if (sourceControlProvider && input.sourceControlSetup.setupSatisfied) {
    candidates.push({
      milestone: 'source_control_authed',
      provider: sourceControlProvider,
      preexisting: sourceControlPreexisting,
    });
  }

  const computeProvider =
    input.setupNewState.computeProvider ??
    input.computeSetup.selectedProvider ??
    input.computeSetup.runtimeDefaultProvider ??
    input.computeSetup.persistedDefaultProvider;
  const computeProviderStatus = input.computeSetup.providers.find(
    (provider) => provider.provider === computeProvider,
  );
  if (computeProvider && computeProviderStatus?.configSatisfied) {
    candidates.push({
      milestone: 'sandbox_configured',
      provider: computeProvider,
      preexisting: input.setupNewState.computeProvider === null,
    });
  }

  return candidates;
}

export async function recordSetupFunnelMilestones(
  candidates: SetupFunnelMilestoneInput[],
): Promise<void> {
  if (candidates.length === 0 || !(await isAnonymousAnalyticsEnabled())) {
    return;
  }

  try {
    const inserted = await db.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext('setup-funnel-milestones'))`,
      );
      await tx
        .insert(deploymentSettings)
        .values({ id: 'default' })
        .onConflictDoNothing();

      const settings = await tx.query.deploymentSettings.findFirst({
        where: eq(deploymentSettings.id, 'default'),
        columns: { metadata: true, setupCompletedAt: true },
      });
      if (!settings || settings.setupCompletedAt !== null) {
        return [];
      }

      const metadata = normalizeMetadata(settings.metadata);
      const result = mergeSetupFunnelMilestones(
        normalizeRecordedMilestones(metadata[METADATA_KEY]),
        candidates,
        new Date().toISOString(),
      );
      if (result.inserted.length === 0) {
        return [];
      }

      await tx
        .update(deploymentSettings)
        .set({
          metadata: sql`jsonb_set(coalesce(${deploymentSettings.metadata}, '{}'::jsonb), ARRAY[${METADATA_KEY}]::text[], ${JSON.stringify(result.milestones)}::jsonb, true)`,
        })
        .where(eq(deploymentSettings.id, 'default'));

      return result.inserted;
    });

    for (const { milestone, provider, preexisting } of inserted) {
      await captureActivationSetupMilestone(milestone, {
        ...(provider === undefined ? {} : { provider }),
        ...(preexisting === undefined ? {} : { preexisting }),
      });
    }
  } catch (error) {
    console.warn(
      '[setup-funnel-telemetry] failed to record milestones:',
      error instanceof Error ? error.message : error,
    );
  }
}
