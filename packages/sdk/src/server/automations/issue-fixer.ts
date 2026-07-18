import {
  emptyJobResult,
  type AutomationJobResult,
  type AutomationRunOpts,
} from './types';

/**
 * Triage GitHub Issues is webhook-driven only (issues.opened / issues.reopened).
 * There is no scheduled or Run now path — that avoids a second prompt beside the
 * webhook handler.
 */
export async function issueFixerJob(
  _opts: AutomationRunOpts = {},
): Promise<AutomationJobResult> {
  const result = emptyJobResult();
  result.skippedReason =
    'Triage GitHub Issues runs from the GitHub issues webhook only.';
  return result;
}
