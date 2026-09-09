import type { FastAgentTurnAttemptEvent } from './fast-agent-conversation-repository';

type Result = Record<string, unknown>;
type MessageArgs = { message: string; includeAttachments?: boolean };
type Continuation = {
  kind: 'instruction' | 'recovery';
  instructionId?: string;
};

const unknownGuidance =
  'Delivery is unknown. Do not resend or reword the instruction. Check the task status and transcript before taking further action.';

function signature(args: MessageArgs, continuation?: Continuation): string {
  // Attachments are fixed within the human instruction boundary. Keep the
  // signature private; persisted receipts already contain the original args.
  return JSON.stringify([
    args.message.trim(),
    args.includeAttachments ?? false,
    ...(continuation
      ? [continuation.kind, continuation.instructionId ?? null]
      : []),
  ]);
}

export class FastAgentTaskMessageGuard {
  private readonly unresolved = new Set<string>();
  private readonly receipts = new Map<string, Map<string, Result>>();
  private readonly recoveryReservations = new Map<string, symbol>();
  private readonly acceptedInstructions = new Map<string, Set<string>>();

  clear(): void {
    this.unresolved.clear();
    this.receipts.clear();
  }

  restoreRecoveryHistory(
    events: FastAgentTurnAttemptEvent[],
    currentTaskIds: string[],
  ): void {
    for (const event of events) {
      if (
        event.kind !== 'action' ||
        event.tool !== 'send_task_message' ||
        !event.continuation
      )
        continue;
      let result: Result = {};
      try {
        const parsed: unknown = JSON.parse(event.result ?? '{}');
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          result = parsed as Result;
        }
      } catch {
        // A truncated recovery receipt still spends the durable budget.
      }
      if (event.status !== 'unknown' && result.delivery === 'not_accepted') {
        continue;
      }
      const args = event.arguments as { taskId?: unknown } | undefined;
      const taskId = [result.taskId, args?.taskId]
        .find(
          (value): value is string =>
            typeof value === 'string' && !!value.trim(),
        )
        ?.trim();
      if (event.continuation === 'recovery') {
        for (const id of taskId ? [taskId] : currentTaskIds) {
          this.recoveryReservations.set(id, Symbol());
        }
      } else if (
        taskId &&
        event.status === 'completed' &&
        result.success === true &&
        result.delivery !== 'unknown'
      ) {
        this.acceptInstruction(taskId, event.instructionId);
      } else {
        // An instruction whose outcome was lost cannot authorize recovery.
        for (const id of taskId ? [taskId] : currentTaskIds) {
          this.recoveryReservations.set(id, Symbol());
        }
      }
    }
  }

  private acceptInstruction(taskId: string, instructionId?: string): void {
    if (!instructionId?.trim()) return;
    const accepted = this.acceptedInstructions.get(taskId) ?? new Set<string>();
    if (accepted.has(instructionId)) return;
    accepted.add(instructionId);
    this.acceptedInstructions.set(taskId, accepted);
    this.recoveryReservations.delete(taskId);
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
        result.delivery !== 'unknown' &&
        typeof args?.message === 'string' &&
        args.message.trim() &&
        (args.includeAttachments === undefined ||
          typeof args.includeAttachments === 'boolean')
      ) {
        this.remember(
          taskId,
          signature(
            args as MessageArgs,
            event.continuation
              ? {
                  kind: event.continuation,
                  instructionId: event.instructionId,
                }
              : undefined,
          ),
          {
            ...result,
            taskId,
          },
        );
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
    continuation?: Continuation,
  ): Promise<Result> {
    const key = signature(args, continuation);
    const receipt = this.receipts.get(taskId)?.get(key);
    if (
      continuation?.kind === 'recovery' &&
      this.recoveryReservations.has(taskId)
    ) {
      if (receipt && !this.unresolved.has(taskId)) return receipt;
      return {
        success: false,
        taskId,
        delivery: 'not_accepted',
        recovery: 'budget_exhausted',
        error:
          'Recovery budget exhausted. A new explicit instruction is required.',
      };
    }
    if (this.unresolved.has(taskId)) {
      return {
        success: false,
        taskId,
        delivery: 'unknown',
        error: unknownGuidance,
      };
    }
    if (receipt) return receipt;
    // Same-turn receipts from before continuation metadata was shipped remain
    // replayable, but never override an already-consumed recovery budget.
    const legacyReceipt = this.receipts.get(taskId)?.get(signature(args));
    if (legacyReceipt) return legacyReceipt;
    const reservation =
      continuation?.kind === 'recovery' ? Symbol() : undefined;
    if (reservation) this.recoveryReservations.set(taskId, reservation);
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
      if (
        reservation &&
        this.recoveryReservations.get(taskId) === reservation
      ) {
        this.recoveryReservations.delete(taskId);
      }
    } else if (result.success === true && result.delivery !== 'unknown') {
      this.unresolved.delete(taskId);
      this.remember(taskId, key, result);
      if (continuation?.kind === 'instruction') {
        this.acceptInstruction(taskId, continuation.instructionId);
      }
    } else {
      result = { ...result, delivery: 'unknown', guidance: unknownGuidance };
    }
    return result;
  }
}
