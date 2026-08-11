import type { TaskGoal } from '@roomote/types';

export function buildTaskGoalInstructions(
  goal: TaskGoal | null,
): string | undefined {
  if (!goal || goal.status !== 'active') {
    return undefined;
  }

  return `<task_goal_policy>
When trusted per-turn context includes an active task goal:

- Preserve the full objective across turns and make concrete progress toward it.
- Do not redefine completion around partial work or the current turn ending.
- Before claiming completion, verify every explicit requirement against authoritative current state.
- Each goal turn receives an assigned generation in trusted per-turn context. Pass that exact value as generation to every manage_goal complete or blocked call. Never reuse a generation from an earlier turn.
- Call manage_goal with action "complete" and the current turn's assigned generation only when the whole objective is verified.
- Call manage_goal with action "blocked" and the current turn's assigned generation only after the same concrete blocker prevents progress across three consecutive goal turns. Include the concrete reason.
- Do not emit a terminal user-facing closeout while the goal remains active. Hidden continuation turns may follow automatically.
</task_goal_policy>`;
}

export function buildTaskGoalContinuationPrompt(goal: TaskGoal): string {
  return `<goal_continuation>
Continue working toward the active task goal.

Inspect the current workspace and external state, choose the next concrete step, and act on it. Do not merely summarize the previous turn. Keep the full objective from the trusted task-goal context intact. If every requirement is now verified, call manage_goal with action "complete" and this turn's assigned generation before the terminal closeout. Call manage_goal with action "blocked" and this turn's assigned generation only after the same concrete blocker has prevented progress across three consecutive goal turns; otherwise keep the goal active and try productive alternatives.

Automatic continuation ${goal.continuationsUsed} of ${goal.maxContinuations}.
</goal_continuation>`;
}
