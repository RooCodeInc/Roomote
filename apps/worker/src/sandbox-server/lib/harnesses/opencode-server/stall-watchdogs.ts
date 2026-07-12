/**
 * Turn stall / steer-pickup timer subsystem for OpenCodeServerHarness.
 *
 * Owns the fire-and-arm/clear lifecycle for:
 * - mid-turn native-steer pickup timestamps
 * - unbounded in-flight turn silence recovery
 *
 * Recovery actions (abort, enqueue, transcript notices) stay on the harness via
 * callbacks so event ingest and prompt control do not move with the timers.
 */

// A natively steered prompt (prompt_async into an active turn) is only read
// by OpenCode between loop steps. When the turn's current LLM stream request
// has silently stalled (observed live: `message=stream providerID=...` with
// no further loop step, no session.idle, no session.error), the loop never
// reaches another step boundary, so the injection call succeeds but the
// prompt sits unseen forever. This window bounds how long a successful
// injection may go with zero turn progress before the steer escalates to the
// queue + abort-and-replay path that failed injections already take. Any
// turn progress disarms it — a live turn reaches its next step boundary, and
// with it the injected prompt, on its own.
export const DEFAULT_OPENCODE_STEER_PICKUP_TIMEOUT_MS = 90_000;

// Fail-safe for a turn wedged inside a single LLM stream request. A stalled
// stream emits nothing — no message events, no session.idle, no
// session.error — so nothing else bounds the turn and the task hangs
// "running" until the sandbox hard deadline. If an in-flight turn produces
// no OpenCode session events for this window, and verification against
// OpenCode's own message state shows no tool part still running (long tool
// executions legitimately emit no events), the turn is treated as wedged:
// aborted, a retryable error surfaced to the transcript, and queued prompts
// drained. Deliberately generous: platform-API MCP calls are bounded at 120s
// and artifact transfers at 600s, so a quiet-but-alive turn either shows a
// running tool part or completes well inside this window.
export const DEFAULT_OPENCODE_TURN_STALL_TIMEOUT_MS = 15 * 60_000;

// A prompt natively injected into an active turn (prompt_async, no abort)
// with no evidence yet that OpenCode's loop picked it up. Retained so a
// pickup stall can replay the same content through the queued
// abort-and-replay path. clientMessageId is deliberately not retained: the
// injection already persisted the visible user prompt under that id, and the
// invisible replay must not collide with it.
export interface PendingSteerPickup {
  text: string;
  images?: string[];
  userId?: string;
  userName?: string;
  userImageUrl?: string;
}

export function formatOpenCodeTurnStallErrorText(
  stallTimeoutMs: number,
): string {
  const minutes = Math.max(1, Math.round(stallTimeoutMs / 60_000));

  return `The session stopped responding mid-turn: no activity arrived from the model for about ${minutes} minute${
    minutes === 1 ? '' : 's'
  }, so the stalled turn was aborted. This is usually a transient provider stall and is safe to retry.`;
}

export type TurnStallVerificationResult =
  | 'no_running_tool'
  | 'running_tool'
  | 'unverified';

export interface OpenCodeStallWatchdogsLogger {
  warn: (message: string) => void;
  error: (message: string) => void;
}

export interface OpenCodeStallWatchdogsOptions {
  steerPickupTimeoutMs: number;
  turnStallTimeoutMs: number;
  logger: OpenCodeStallWatchdogsLogger;
  isDisposed: () => boolean;
  isInFlight: () => boolean;
  getSessionId: () => string | undefined;
  /**
   * Quiet-but-alive states that must postpone stall recovery: pending
   * questions, tracked execute tools, and active subagent runs.
   */
  hasDeferringActivity: () => boolean;
  /**
   * Server-side verification that the latest assistant tool part is not still
   * running. `'unverified'` never recovers (prefer waiting over a false abort).
   */
  verifyNoRunningTool: (
    sessionId: string,
  ) => Promise<TurnStallVerificationResult>;
  onSteerPickupStall: (pending: PendingSteerPickup[]) => Promise<void>;
  onTurnStalled: (sessionId: string) => Promise<void>;
}

export class OpenCodeStallWatchdogs {
  private readonly steerPickupTimeoutMs: number;
  private readonly turnStallTimeoutMs: number;
  private readonly logger: OpenCodeStallWatchdogsLogger;
  private readonly isDisposed: () => boolean;
  private readonly isInFlight: () => boolean;
  private readonly getSessionId: () => string | undefined;
  private readonly hasDeferringActivity: () => boolean;
  private readonly verifyNoRunningTool: (
    sessionId: string,
  ) => Promise<TurnStallVerificationResult>;
  private readonly onSteerPickupStall: (
    pending: PendingSteerPickup[],
  ) => Promise<void>;
  private readonly onTurnStalled: (sessionId: string) => Promise<void>;

  private steerPickupTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingSteerPickups: PendingSteerPickup[] = [];
  private turnStallTimer: ReturnType<typeof setTimeout> | null = null;
  private lastTurnEventAtMs = 0;

  constructor(options: OpenCodeStallWatchdogsOptions) {
    this.steerPickupTimeoutMs = options.steerPickupTimeoutMs;
    this.turnStallTimeoutMs = options.turnStallTimeoutMs;
    this.logger = options.logger;
    this.isDisposed = options.isDisposed;
    this.isInFlight = options.isInFlight;
    this.getSessionId = options.getSessionId;
    this.hasDeferringActivity = options.hasDeferringActivity;
    this.verifyNoRunningTool = options.verifyNoRunningTool;
    this.onSteerPickupStall = options.onSteerPickupStall;
    this.onTurnStalled = options.onTurnStalled;
  }

  get turnStallTimeoutMsValue(): number {
    return this.turnStallTimeoutMs;
  }

  armSteerPickup(steer: PendingSteerPickup): void {
    this.pendingSteerPickups.push(steer);

    if (this.steerPickupTimer) {
      clearTimeout(this.steerPickupTimer);
    }

    const timer = setTimeout(() => {
      void this.handleSteerPickupStall().catch((error: unknown) => {
        this.logger.error(
          `OpenCode steer pickup escalation failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      });
    }, this.steerPickupTimeoutMs);
    timer.unref?.();
    this.steerPickupTimer = timer;
  }

  clearSteerPickup(): void {
    if (this.steerPickupTimer) {
      clearTimeout(this.steerPickupTimer);
      this.steerPickupTimer = null;
    }

    if (this.pendingSteerPickups.length > 0) {
      this.pendingSteerPickups = [];
    }
  }

  /** Any session event that proves the OpenCode session is alive. */
  noteActivity(): void {
    this.lastTurnEventAtMs = Date.now();
  }

  /**
   * Evidence the in-flight turn is actually advancing (assistant message or
   * part activity, child-session activity). Beyond refreshing the stall
   * window this disarms the steer-pickup watchdog: a turn that is making
   * progress reaches its next loop step — and with it any injected prompt —
   * on its own.
   */
  noteProgress(): void {
    this.noteActivity();
    this.clearSteerPickup();
  }

  armTurnStall(): void {
    this.noteActivity();
    this.scheduleTurnStallCheck(this.turnStallTimeoutMs);
  }

  /** Keep a turn-stall check scheduled if one is not already pending. */
  ensureTurnStallArmed(): void {
    if (!this.turnStallTimer) {
      this.scheduleTurnStallCheck(this.turnStallTimeoutMs);
    }
  }

  clearTurnStall(): void {
    if (this.turnStallTimer) {
      clearTimeout(this.turnStallTimer);
      this.turnStallTimer = null;
    }
  }

  /** End of turn / dispose — disarm both watchdogs. */
  clearAll(): void {
    this.clearSteerPickup();
    this.clearTurnStall();
  }

  private scheduleTurnStallCheck(delayMs: number): void {
    this.clearTurnStall();
    const timer = setTimeout(() => {
      void this.handleTurnStallCheck().catch((error: unknown) => {
        this.logger.error(
          `OpenCode turn stall check failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      });
    }, delayMs);
    timer.unref?.();
    this.turnStallTimer = timer;
  }

  /**
   * Fires when a successfully injected mid-turn steer saw no turn progress
   * within the pickup window: the turn is presumed stalled inside a single
   * LLM stream request, where OpenCode never reaches the loop step boundary
   * that would read the injection. Escalate via host callback so the harness
   * can queue + prioritize + abort-and-replay.
   */
  private async handleSteerPickupStall(): Promise<void> {
    this.steerPickupTimer = null;
    const pending = this.pendingSteerPickups;
    this.pendingSteerPickups = [];

    if (this.isDisposed() || pending.length === 0 || !this.isInFlight()) {
      return;
    }

    this.logger.warn(
      `OpenCode showed no turn progress within ${this.steerPickupTimeoutMs}ms of a native mid-turn steer injection; escalating ${pending.length} steer(s) to abort-and-replay so they land.`,
    );

    await this.onSteerPickupStall(pending);
  }

  /**
   * A turn wedged inside a single LLM stream request emits nothing: no
   * message events, no session.idle, no session.error. Left alone it hangs
   * "running" until the sandbox hard deadline and natively injected steers
   * are never read. This check fires after `turnStallTimeoutMs` of event
   * silence on an in-flight turn and treats the session as wedged — but only
   * after ruling out every quiet-but-alive state (local trackers and a
   * server-side running tool-part check).
   *
   * A failed verification lookup proves nothing and never recovers: a false
   * abort kills real work while an extra wait only delays an already-wedged
   * turn, so every margin leans toward waiting.
   */
  private async handleTurnStallCheck(): Promise<void> {
    this.turnStallTimer = null;
    const sessionId = this.getSessionId();

    if (this.isDisposed() || !this.isInFlight() || !sessionId) {
      return;
    }

    const idleMs = Date.now() - this.lastTurnEventAtMs;

    if (idleMs < this.turnStallTimeoutMs) {
      this.scheduleTurnStallCheck(this.turnStallTimeoutMs - idleMs);
      return;
    }

    if (this.hasDeferringActivity()) {
      this.scheduleTurnStallCheck(this.turnStallTimeoutMs);
      return;
    }

    // Host returns 'unverified' on lookup failure (and logs the warn itself).
    // Both 'unverified' and 'running_tool' leave the window re-armed; only
    // 'no_running_tool' is a candidate for recovery.
    let verifiedNoRunningTool = false;

    try {
      const verification = await this.verifyNoRunningTool(sessionId);
      verifiedNoRunningTool = verification === 'no_running_tool';
    } catch (error) {
      // Defensive: treat unexpected throws like unverified lookup failure.
      this.logger.warn(
        `Could not verify OpenCode session ${sessionId} before recovering a stalled turn; leaving it running: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    // The verification round-tripped (or failed): re-check that nothing moved
    // meanwhile before either recovering or re-arming.
    if (this.isDisposed() || !this.isInFlight() || this.turnStallTimer) {
      return;
    }

    if (!verifiedNoRunningTool) {
      this.scheduleTurnStallCheck(this.turnStallTimeoutMs);
      return;
    }

    const idleAfterVerifyMs = Date.now() - this.lastTurnEventAtMs;

    if (idleAfterVerifyMs < this.turnStallTimeoutMs) {
      this.scheduleTurnStallCheck(this.turnStallTimeoutMs - idleAfterVerifyMs);
      return;
    }

    await this.onTurnStalled(sessionId);
  }
}
