export const DEFAULT_OPENCODE_STOP_HOOK_REMINDER_STALL_TIMEOUT_MS = 10 * 60_000;
export const MAX_OPENCODE_STOP_HOOK_REMINDERS = 3;

interface OpenCodeStopHookReminderStallCallbacks {
  logger: {
    warn: (message: string) => void;
  };
  isDisposed: () => boolean;
  /** Force-complete a wedged turn (mirrors the original stall handler body). */
  onStall: (sessionId: string) => Promise<void>;
}

/**
 * Fail-safe for a wedged stop-hook reminder cycle. After a turn finishes
 * without the required Slack closeout, the harness resubmits a reminder and
 * waits for a fresh turn. If OpenCode never produces that turn, this deadline
 * force-completes so the job reaches a terminal state instead of hanging.
 */
export class OpenCodeStopHookReminderStall {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private reminderCount = 0;

  constructor(
    private readonly stallTimeoutMs: number,
    private readonly callbacks: OpenCodeStopHookReminderStallCallbacks,
  ) {}

  get count(): number {
    return this.reminderCount;
  }

  resetCount(): void {
    this.reminderCount = 0;
  }

  /**
   * Increment the reminder budget. Returns true when another reminder is still
   * allowed, false when the budget is exhausted (caller should give up).
   */
  tryConsumeReminder(): boolean {
    if (this.reminderCount >= MAX_OPENCODE_STOP_HOOK_REMINDERS) {
      return false;
    }

    this.reminderCount += 1;
    return true;
  }

  arm(sessionId: string): void {
    this.clear();
    const timer = setTimeout(() => {
      void this.handleStall(sessionId);
    }, this.stallTimeoutMs);
    timer.unref?.();
    this.timer = timer;
  }

  clear(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private async handleStall(sessionId: string): Promise<void> {
    this.clear();

    if (this.callbacks.isDisposed()) {
      return;
    }

    this.callbacks.logger.warn(
      `OpenCode stop-hook reminder produced no follow-up turn within ${this.stallTimeoutMs}ms; the session appears wedged. Force-completing the turn so the task reaches a terminal state.`,
    );
    this.reminderCount = 0;
    await this.callbacks.onStall(sessionId);
  }
}
