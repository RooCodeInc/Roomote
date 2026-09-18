import type { FastAgentTurnAttemptEvent } from './fast-agent-conversation-repository';

type Result = Record<string, unknown>;
type MessageArgs = { message: string; includeAttachments?: boolean };

const unknownGuidance =
  'Delivery is unknown. Do not resend or reword the instruction. Check the task status and transcript before taking further action.';

function signature(args: MessageArgs): string {
  // Attachments are fixed within the human instruction boundary. Keep the
  // signature private; persisted receipts already contain the original args.
  return JSON.stringify([
    args.message.trim(),
    args.includeAttachments ?? false,
  ]);
}

export class FastAgentTaskMessageGuard {
  private readonly unresolved = new Set<string>();
  private readonly receipts = new Map<string, Map<string, Result>>();

  clear(): void {
    this.unresolved.clear();
    this.receipts.clear();
  }

  restore(events: FastAgentTurnAttemptEvent[], currentTaskIds: string[]): void {
    for (const event of events) {
      if (event.kind !== 'action' || event.tool !== 'send_task_message')
        continue;
      let result: Result = {};
      try {
        const parsed: unknown = JSON.parse(event.result ?? '{}');
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          result = parsed as Result;
        }
      } catch {
        // Missing/truncated receipts cannot prove that delivery was rejected.
      }
      if (event.status !== 'unknown' && result.delivery === 'not_accepted') {
        continue;
      }
      const args = event.arguments as Partial<MessageArgs> & {
        taskId?: unknown;
      };
      const taskId =
        [result.taskId, args?.taskId]
          .find(
            (value): value is string =>
              typeof value === 'string' && !!value.trim(),
          )
          ?.trim() ??
        (currentTaskIds.length === 1 ? currentTaskIds[0] : undefined);
      if (!taskId) {
        for (const id of currentTaskIds) this.unresolved.add(id);
        continue;
      }
      if (
        event.status === 'completed' &&
        result.success === true &&
        typeof args?.message === 'string' &&
        args.message.trim() &&
        (args.includeAttachments === undefined ||
          typeof args.includeAttachments === 'boolean')
      ) {
        this.remember(taskId, signature(args as MessageArgs), {
          ...result,
          taskId,
        });
      } else {
        this.unresolved.add(taskId);
      }
    }
  }

  private remember(taskId: string, key: string, result: Result): void {
    const receipts = this.receipts.get(taskId) ?? new Map<string, Result>();
    receipts.set(key, result);
    this.receipts.set(taskId, receipts);
  }

  async send(
    taskId: string,
    args: MessageArgs,
    deliver: () => Promise<Result>,
  ): Promise<Result> {
    if (this.unresolved.has(taskId)) {
      return {
        success: false,
        taskId,
        delivery: 'unknown',
        error: unknownGuidance,
      };
    }
    const key = signature(args);
    const receipt = this.receipts.get(taskId)?.get(key);
    if (receipt) return receipt;
    this.unresolved.add(taskId);
    let result: Result;
    try {
      result = await deliver();
    } catch (error) {
      result = {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
    result = { ...result, taskId };
    if (result.delivery === 'not_accepted') {
      this.unresolved.delete(taskId);
    } else if (result.success === true) {
      this.unresolved.delete(taskId);
      this.remember(taskId, key, result);
    } else {
      result = { ...result, delivery: 'unknown', guidance: unknownGuidance };
    }
    return result;
  }
}
