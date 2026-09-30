import type { JudgmentDecisionId } from './judgment-decision-catalog';

/**
 * By default, only decisions explicitly listed here may use the
 * Roomote-trained model. Unknown and newly added decisions stay Jev-only until
 * they are evaluated and added to this registry.
 */
const JUDGMENT_DECISION_POLICY: Record<string, { roomoteModel: boolean }> = {
  'fast-agent-post-turn-memory': { roomoteModel: true },
  'task-run-memory-distillation': { roomoteModel: true },
  'unmentioned-thread-reply': { roomoteModel: true },
  'fast-agent-task-communication-triage': { roomoteModel: true },
  'fast-agent-launch-model': { roomoteModel: true },
  'channel-launch-gate': { roomoteModel: true },
  'requested-work-kind': { roomoteModel: true },
  'agentmail-auto-reply': { roomoteModel: true },
  // Auto approves calls on its own, so an answer it cannot trust is unsafe,
  // not just wrong. The Roomote judgment model misjudges whether a call
  // matches the request, and it only sees the first 8,000 characters of the
  // state, which can drop the content an injection check depends on.
  'integration-tool-auto-evaluation': { roomoteModel: false },
  'session-status-judgment': { roomoteModel: true },
  'custom-automation-launch-gate': { roomoteModel: true },
};

export type { JudgmentDecisionId } from './judgment-decision-catalog';

export function getDecisionModelRequirements(decision?: JudgmentDecisionId): {
  excludeRoomoteModel: boolean;
} {
  return {
    excludeRoomoteModel:
      JUDGMENT_DECISION_POLICY[decision ?? '']?.roomoteModel !== true,
  };
}
