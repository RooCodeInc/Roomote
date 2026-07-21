import {
  emptyJobResult,
  type AutomationJobResult,
  type AutomationRunOpts,
} from './types';

/**
 * Triage Issues is webhook-driven only (issue opened / reopened on GitHub,
 * GitLab, or Gitea). There is no scheduled or Run now path — that avoids a
 * second prompt beside the webhook handlers.
 */
export async function issueFixerJob(
  _opts: AutomationRunOpts = {},
): Promise<AutomationJobResult> {
  const result = emptyJobResult();
  result.skippedReason =
    'Triage Issues runs from source-control issue webhooks only (GitHub, GitLab, Gitea).';
  return result;
}
