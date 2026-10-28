import {
  resolveBrainEnabledState,
  resolveModelProviderEnvValue,
} from '@roomote/db/server';
import type { UserAuthSuccess } from '@/types';
import { Env } from '@/lib/server/env';

import { assertAdmin } from '../setup/shared';
import { hasBrainCredentials } from './brain-credentials';
import type { BrainSettings } from './brain-settings-types';
import { resolveBrainSettingsStatus } from './brain-settings-status';
import { loadBrainSettings } from './load-brain-settings';
import { summarizeSources } from './summarize-sources';

export async function getBrainSettingsCommand(
  auth: UserAuthSuccess,
): Promise<BrainSettings> {
  assertAdmin(auth);

  const enabledState = await resolveBrainEnabledState();
  const configured = enabledState.enabled;
  const url = Env.R_GBRAIN_URL ?? null;
  const loaded = await loadBrainSettings(configured);
  const provisioned =
    configured && !loaded.corpus.reachable ? await hasBrainCredentials() : true;
  const keySource: BrainSettings['keySource'] = !loaded.inference
    ? null
    : (
          await resolveModelProviderEnvValue([
            loaded.inference.providerId === 'openrouter'
              ? 'R_BRAIN_OPENROUTER_API_KEY'
              : 'R_BRAIN_OPENAI_API_KEY',
          ])
        )?.trim()
      ? 'brain'
      : 'deployment';
  const memoryTotal = Object.values(loaded.memories.byStatus).reduce(
    (total, value) => total + value,
    0,
  );
  const { status, statusDetail } = resolveBrainSettingsStatus({
    configured,
    url,
    embeddingsAvailable: loaded.embeddingsAvailable,
    corpusReachable: loaded.corpus.reachable,
    provisioned,
  });

  return {
    status,
    statusDetail,
    enabled: enabledState.enabled,
    enabledFromLegacyKey: enabledState.enabled && enabledState.fromLegacyKey,
    url,
    inferenceProvider: loaded.inference?.providerId ?? 'helper',
    embeddingsAvailable: loaded.embeddingsAvailable,
    keySource,
    recall: loaded.recall,
    corpus: loaded.corpus,
    sources: summarizeSources({
      syncStates: loaded.syncStates,
      itemCounts: loaded.itemCounts,
      requirements: loaded.requirements,
      taskMemoriesActive: memoryTotal > 0,
      taskMemoriesLastProcessedAt: loaded.memories.lastProcessedAt,
    }),
    taskMemories: {
      byStatus: loaded.memories.byStatus,
      total: memoryTotal,
      lastProcessedAt: loaded.memories.lastProcessedAt,
      lastError: loaded.memories.lastError,
      historicalCompletedRunsWithoutEvent:
        loaded.memories.historicalCompletedRunsWithoutEvent,
      recentCompletedRunsWithoutEvent:
        loaded.memories.recentCompletedRunsWithoutEvent,
    },
  };
}
