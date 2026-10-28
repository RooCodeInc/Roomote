import type { BrainCorpusSummary } from './brain-corpus-types';
import type { BrainSourceSummary } from './brain-source-types';
import type { BrainStatus } from './brain-settings-status';

export type BrainSettings = {
  status: BrainStatus;
  /** Why the status is not `connected`, in one sentence, or null. */
  statusDetail: string | null;
  /** Effective Brain on/off state, as the Settings toggle should render it. */
  enabled: boolean;
  /**
   * True when `enabled` comes from the legacy activation signal (an explicit
   * R_BRAIN_* provider key) rather than an explicit Settings choice.
   */
  enabledFromLegacyKey: boolean;
  url: string | null;
  inferenceProvider: 'openrouter' | 'openai' | 'helper' | null;
  /**
   * Whether the serving key is the Brain's own (`R_BRAIN_*`) or the
   * deployment's general provider key.
   */
  keySource: 'brain' | 'deployment' | null;
  /**
   * Recall health. `semantic`/`keyword-only` are measured from gbrain's own
   * embedding counts; `unknown` means the admin census did not answer.
   */
  recall: {
    mode: 'semantic' | 'keyword-only' | 'unknown';
    embeddedCount: number | null;
    chunkCount: number | null;
  };
  /**
   * Whether an embedding path exists at all (a dedicated embedder upstream
   * or an embeddings-capable provider key).
   */
  embeddingsAvailable: boolean;
  corpus: BrainCorpusSummary;
  sources: BrainSourceSummary[];
  taskMemories: {
    byStatus: Record<
      'pending' | 'processing' | 'done' | 'skipped' | 'failed',
      number
    >;
    total: number;
    lastProcessedAt: Date | null;
    lastError: string | null;
    historicalCompletedRunsWithoutEvent: number;
    recentCompletedRunsWithoutEvent: number;
  };
};
