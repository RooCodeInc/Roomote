import { TaskPayloadKind } from '@roomote/types';

type AutomationScanLaunch = {
  task: { type: unknown; payload: unknown };
  workflow: string;
  initiator: { kind: string };
};

/**
 * Automation-originated scan workflows report terminal results, not progress,
 * to their channel. User scans and spawned StandardTask executions keep their
 * own reply policy.
 */
export function withAutomationScanReplyPolicy<T extends AutomationScanLaunch>(
  input: T,
): T {
  if (
    input.task.type !== TaskPayloadKind.Scan ||
    input.workflow !== 'scan' ||
    input.initiator.kind !== 'automation' ||
    !input.task.payload ||
    typeof input.task.payload !== 'object' ||
    Array.isArray(input.task.payload)
  ) {
    return input;
  }

  return {
    ...input,
    task: {
      ...input.task,
      payload: {
        ...(input.task.payload as Record<string, unknown>),
        suppressNonTerminalRepliesWithoutTurn: true,
      },
    },
  } as T;
}
