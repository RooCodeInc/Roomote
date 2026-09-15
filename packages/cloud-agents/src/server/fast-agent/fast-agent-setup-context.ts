import { db, deploymentSettings, eq, sessions, sql } from '@roomote/db/server';
import {
  normalizeSetupNewState,
  normalizeSetupNewSetupSession,
  SETUP_INTEGRATIONS,
  SETUP_INTEGRATION_RECOMMENDATIONS,
  SETUP_INTEGRATIONS_CONTINUE_OPTION,
  SETUP_INTEGRATIONS_QUESTION_ID,
  type FastAgentCapabilityOfferInput,
  type FastAgentCapabilitySnapshot,
  matchSetupIntegrationAnswers,
  type FastAgentSetupTurnContext,
} from '@roomote/types';

import type { FastAgentTurnAdapter } from './fast-agent-conversation';

type SetupSnapshot = {
  capabilities?: FastAgentCapabilitySnapshot['capabilities'];
  integrationDiscovery?: {
    completed?: boolean;
    skipped?: boolean;
    matchedIntegrationIds?: string[];
  };
  integrationAvailability?: {
    connectedIntegrationIds?: string[];
    offerableIntegrationIds?: string[];
  };
  sourceControl?: {
    providers?: Array<{
      provider: string;
      connected: boolean;
      repositoryCount: number;
    }>;
  };
  rail?: {
    compute?: string;
    source?: string;
    firstWork?: string;
  };
};

type FastAgentSetupAdapter = Partial<
  Pick<
    FastAgentTurnAdapter,
    | 'assertTaskLaunch'
    | 'resolveUserInputPreset'
    | 'offerCapability'
    | 'onTurnSettled'
  >
>;

function parseSetupSnapshot(context: FastAgentSetupTurnContext): SetupSnapshot {
  try {
    return JSON.parse(context.setupSnapshot) as SetupSnapshot;
  } catch {
    throw new Error('The setup snapshot is invalid.');
  }
}

async function completeEmptySetupIntegrationDiscovery(
  context: FastAgentSetupTurnContext,
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext('setup-session'))`,
    );
    const [settings] = await tx
      .select({ setupNewState: deploymentSettings.setupNewState })
      .from(deploymentSettings)
      .where(eq(deploymentSettings.id, 'default'))
      .limit(1);
    const state = normalizeSetupNewState(settings?.setupNewState ?? {});
    const setupSession = normalizeSetupNewSetupSession(state.setupSession);
    const [session] = setupSession
      ? await tx
          .select({ fastConversationId: sessions.fastConversationId })
          .from(sessions)
          .where(eq(sessions.id, setupSession.sessionId))
          .limit(1)
      : [];
    if (
      !setupSession ||
      setupSession.sessionId !== context.sessionId ||
      session?.fastConversationId !== context.fastConversationId
    ) {
      throw new Error('This request does not belong to the setup Session.');
    }
    // Missing means a legacy session that predates discovery and is already complete.
    if (setupSession.integrationDiscoveryCompletedAt !== null) return;
    await tx
      .update(deploymentSettings)
      .set({
        setupNewState: {
          ...state,
          setupSession: {
            ...setupSession,
            integrationDiscoveryCompletedAt: new Date().toISOString(),
          },
        },
        updatedAt: new Date(),
      })
      .where(eq(deploymentSettings.id, 'default'));
  });
}

/** Keep only the qualifiers that apply to the offered capability. */
export function dropIrrelevantOfferQualifiers(
  input: FastAgentCapabilityOfferInput,
): FastAgentCapabilityOfferInput {
  const { provider, integrationIds, ...rest } = input;
  return {
    ...rest,
    ...(input.capability === 'source_control' && provider ? { provider } : {}),
    ...(input.capability === 'integrations' && integrationIds?.length
      ? { integrationIds }
      : {}),
  };
}

/** Rebuild trusted setup-only adapter behavior from durable, serializable data. */
export function buildFastAgentSetupAdapter(
  context: FastAgentSetupTurnContext,
  lifecycle: {
    onIntegrationDiscoveryCompleted?: () => Promise<void>;
    onTurnSettled?: () => Promise<void>;
    setupSession?: boolean;
  } = {},
): FastAgentSetupAdapter {
  const adapter: FastAgentSetupAdapter = {
    ...(lifecycle.onTurnSettled
      ? { onTurnSettled: lifecycle.onTurnSettled }
      : {}),
    offerCapability: async (rawInput: FastAgentCapabilityOfferInput) => {
      const snapshot = parseSetupSnapshot(context);
      const capability = snapshot.capabilities?.[rawInput.capability];
      if (!capability?.canOffer) {
        throw new Error(
          capability?.unavailableReason ??
            'That capability is not currently available to offer.',
        );
      }
      // Some models carry every optional argument forward from the previous
      // call (a source-control provider on an integrations offer, or an
      // empty integration list on a source-control offer) and retry the
      // identical call when it is rejected. The capability decides which
      // qualifiers apply; the rest are ignored rather than refused.
      const input = dropIrrelevantOfferQualifiers(rawInput);
      if (input.provider && snapshot.sourceControl?.providers) {
        const provider = snapshot.sourceControl.providers.find(
          (candidate) => candidate.provider === input.provider,
        );
        if (!provider) {
          throw new Error('That source-control provider is not available.');
        }
        if (provider.connected && provider.repositoryCount > 0) {
          throw new Error(
            'That source-control provider already has repositories ready.',
          );
        }
      }
      if (
        input.integrationIds?.some(
          (id) =>
            !SETUP_INTEGRATIONS.some((integration) => integration.id === id),
        )
      ) {
        throw new Error('An offered integration was not found.');
      }
      if (input.capability === 'integrations') {
        const offerableIds = new Set(
          snapshot.integrationAvailability?.offerableIntegrationIds ??
            SETUP_INTEGRATIONS.map((integration) => integration.id),
        );
        const requestedIds = input.integrationIds?.length
          ? input.integrationIds
          : SETUP_INTEGRATION_RECOMMENDATIONS.some((id) => offerableIds.has(id))
            ? SETUP_INTEGRATION_RECOMMENDATIONS
            : [...offerableIds];
        const disconnectedIds = requestedIds.filter((id) =>
          offerableIds.has(id),
        );
        if (disconnectedIds.length === 0) {
          throw new Error('All requested integrations are already connected.');
        }
        return { ...input, integrationIds: disconnectedIds };
      }
      return input;
    },
    resolveUserInputPreset: async (preset, setupIntegrationAnswers) => {
      const snapshot = parseSetupSnapshot(context);
      if (preset === 'setup_source_control') {
        if (!['pending', ''].includes(snapshot.rail?.source ?? '')) {
          throw new Error('Source control has already been decided.');
        }
        // The source-control controls are rendered directly in the setup
        // timeline. This preset acknowledges that trusted UI without creating
        // a duplicate structured-input request.
        return [];
      }
      if (preset === 'setup_integrations') {
        if (!['ready', 'skipped'].includes(snapshot.rail?.source ?? '')) {
          throw new Error(
            'Connect source control or choose not to connect it before continuing with integrations.',
          );
        }
        if (snapshot.integrationDiscovery?.completed) {
          // A coalesced setup-state event can still mention the source-control
          // decision after the administrator has resolved this offer. Treat a
          // replayed preset as an already-closed action rather than exposing a
          // tool error or recreating the card.
          return [];
        }
        const suppliedMatches = matchSetupIntegrationAnswers(
          setupIntegrationAnswers ?? {},
        ).matchedIntegrationIds;
        const suppliedOrPersistedIds = [
          ...(snapshot.integrationDiscovery?.matchedIntegrationIds ?? []),
          ...suppliedMatches,
        ];
        const matchedIds = new Set(
          suppliedOrPersistedIds.length > 0
            ? suppliedOrPersistedIds
            : snapshot.integrationDiscovery?.skipped
              ? []
              : SETUP_INTEGRATION_RECOMMENDATIONS,
        );
        const options = SETUP_INTEGRATIONS.filter((integration) =>
          matchedIds.has(integration.id),
        ).map((integration) => ({
          id: integration.id,
          label: integration.name,
          description: `Connect ${integration.name} in Settings.`,
        }));
        if (options.length === 0) {
          await completeEmptySetupIntegrationDiscovery(context);
          await lifecycle.onIntegrationDiscoveryCompleted?.();
          return [];
        }
        return [
          {
            id: SETUP_INTEGRATIONS_QUESTION_ID,
            header: 'Your tools',
            question:
              'Connect any useful tools, or continue without connections.',
            isOther: false,
            isSecret: false,
            options: [...options, SETUP_INTEGRATIONS_CONTINUE_OPTION],
          },
        ];
      }
      if (preset !== 'setup_starter_tasks') {
        throw new Error('Unsupported setup input preset.');
      }
      const rail = snapshot.rail;
      if (rail?.source !== 'ready') {
        throw new Error(
          'Connect source control and sync at least one repository before choosing or starting work.',
        );
      }
      return [
        {
          id: 'setup-starter-tasks',
          header: 'First work',
          question: 'What should Roomote work on first?',
          isOther: false,
          isSecret: false,
          multiple: true,
          options: context.starterTaskOptions,
        },
      ];
    },
    assertTaskLaunch: async () => {
      const rail = parseSetupSnapshot(context).rail;
      if (rail?.source !== 'ready') {
        throw new Error(
          'Connect source control and sync at least one repository before choosing or starting work.',
        );
      }
      if (rail.firstWork !== 'ready') {
        throw new Error('Choose your first work before starting a task.');
      }
      if (rail.compute !== 'ready') {
        throw new Error('Set up a sandbox before starting work.');
      }
    },
  };

  if (lifecycle.setupSession === false) {
    delete adapter.resolveUserInputPreset;
    delete adapter.assertTaskLaunch;
  }
  return adapter;
}
