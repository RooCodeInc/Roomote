import type { ResolvedAutomationDestination } from './destination';

export type AutomationRunOpts = {
  manualTrigger?: boolean;
  /** Destination selected by the caller for a one-off run. */
  destination?: ResolvedAutomationDestination;
};

/**
 * Aggregate result of one automation pass (scheduled tick or manual Run now).
 */
export type AutomationJobResult = {
  /** Task launched by this pass, when the automation launches tasks. */
  launchedTaskId: string | null;
  /**
   * True when the pass did its work without launching a task (announcer /
   * manager stats posting directly to Slack, or an intentional no-op pass
   * that still counts as a run).
   */
  completed: boolean;
  /** Populated when the pass was skipped before doing any work. */
  skippedReason: string | null;
  errors: string[];
};

export function emptyJobResult(): AutomationJobResult {
  return {
    launchedTaskId: null,
    completed: false,
    skippedReason: null,
    errors: [],
  };
}

/**
 * Result surfaced to the settings UI for a synchronous manual Run now.
 */
export type AutomationRunNowResult =
  | { outcome: 'launched'; taskId: string }
  | { outcome: 'completed' }
  | { outcome: 'skipped'; reason: string }
  | { outcome: 'failed'; error: string };
