import { PACKAGED_WORKFLOW_PHASE_SKILL_INVOCATIONS } from '@roomote/cloud-agents';
import {
  normalizeProviderUsageWorkflowPhase,
  type RequestedWorkKind,
} from '@roomote/types';

const EXPLICIT_WORKFLOW_PHASE_PATTERN = /^\s*[$/]([A-Za-z0-9._-]+)(?=\s|$)/u;

const PACKAGED_WORKFLOW_PHASE_SET = new Set<string>(
  PACKAGED_WORKFLOW_PHASE_SKILL_INVOCATIONS,
);

function extractExplicitWorkflowPhase(
  text: string | null | undefined,
): string | null {
  const match = text?.match(EXPLICIT_WORKFLOW_PHASE_PATTERN);
  const workflowPhase = normalizeProviderUsageWorkflowPhase(match?.[1]);

  return workflowPhase && PACKAGED_WORKFLOW_PHASE_SET.has(workflowPhase)
    ? workflowPhase
    : null;
}

function getWorkflowPhaseForRequestedWorkKind(
  requestedWorkKind: RequestedWorkKind | null | undefined,
): string | null {
  switch (requestedWorkKind) {
    case 'question':
      return 'explain-repo-code';
    case 'plan':
    case 'unknown':
      return 'plan-repo-implementation';
    case 'implement':
      return 'implement-changes';
    default:
      return null;
  }
}

export function getInitialWorkflowPhase(options: {
  prompt: string | null | undefined;
  requestedWorkKind: RequestedWorkKind | null | undefined;
}): string | null {
  return (
    extractExplicitWorkflowPhase(options.prompt) ??
    getWorkflowPhaseForRequestedWorkKind(options.requestedWorkKind)
  );
}

export function getFollowUpWorkflowPhase(
  prompt: string | null | undefined,
): string | null {
  return extractExplicitWorkflowPhase(prompt);
}
