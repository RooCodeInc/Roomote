import { db, deploymentSettings, eq, sessions, sql } from '@roomote/db/server';
import {
  normalizeSetupNewState,
  normalizeSetupNewSetupSession,
  SETUP_INTEGRATIONS,
  SETUP_INTEGRATIONS_CONTINUE_OPTION,
  SETUP_INTEGRATIONS_QUESTION_ID,
  matchSetupIntegrationAnswers,
  type FastAgentSetupTurnContext,
} from '@roomote/types';

import type { FastAgentTurnAdapter } from './fast-agent-conversation';

type SetupSnapshot = {
  integrationDiscovery?: {
    completed?: boolean;
    matchedIntegrationIds?: string[];
  };
  rail?: {
    compute?: string;
    source?: string;
    firstWork?: string;
  };
};

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

/** Rebuild trusted setup-only adapter behavior from durable, serializable data. */
export function buildFastAgentSetupAdapter(
  context: FastAgentSetupTurnContext,
): Pick<FastAgentTurnAdapter, 'assertTaskLaunch' | 'resolveUserInputPreset'> {
  return {
    resolveUserInputPreset: async (preset, setupIntegrationAnswers) => {
      const snapshot = parseSetupSnapshot(context);
      if (preset === 'setup_integrations') {
        if (snapshot.integrationDiscovery?.completed) {
          throw new Error('Optional tool discovery is already complete.');
        }
        const suppliedMatches = matchSetupIntegrationAnswers(
          setupIntegrationAnswers ?? {},
        ).matchedIntegrationIds;
        const matchedIds = new Set([
          ...(snapshot.integrationDiscovery?.matchedIntegrationIds ?? []),
          ...suppliedMatches,
        ]);
        const options = SETUP_INTEGRATIONS.filter((integration) =>
          matchedIds.has(integration.id),
        ).map((integration) => ({
          id: integration.id,
          label: integration.name,
          description: `Connect ${integration.name} in Settings.`,
        }));
        if (options.length === 0) {
          await completeEmptySetupIntegrationDiscovery(context);
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
}
