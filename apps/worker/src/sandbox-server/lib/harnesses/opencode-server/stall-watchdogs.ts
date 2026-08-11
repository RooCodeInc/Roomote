/**
 * Turn-stall timer subsystem for OpenCodeServerHarness.
 *
 * Owns unbounded in-flight turn silence recovery and retains native steers so
 * a verified stalled turn can replay them after recovery.
 *
 * Recovery actions (abort, enqueue, transcript notices) stay on the harness via
 * callbacks so event ingest and prompt control do not move with the timers.
 */

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

// A prompt natively injected into an active turn (prompt_async, no abort).
// Retained until the turn progresses so verified whole-turn stall recovery can
// replay it. clientMessageId is deliberately omitted: the injection already
// persisted the visible user prompt under that id, and an invisible replay
// must not collide with it.
export interface PendingSteerPickup {
  text: string;
  images?: string[];
  userId?: string;
  userName?: string;
  userImageUrl?: string;
  goalContext?: import('@roomote/types').TaskGoal;
}

export function formatOpenCodeTurnStallErrorText(
  stallTimeoutMs: number,
): string {
  const minutes = Math.max(1, Math.round(stallTimeoutMs / 60_000));

  return `The session stopped responding mid-turn: no activity arrived from the model for about ${minutes} minute${
    minutes === 1 ? '' : 's'
  }, so the stalled turn was aborted. This is usually a transient provider stall and is safe to retry.`;
}

type TurnStallVerificationResult =
  | 'no_running_tool'
  | 'running_tool'
  | 'unverified';

interface OpenCodeStallWatchdogsLogger {
  warn: (message: string) => void;
  error: (message: string) => void;
}

interface OpenCodeStallWatchdogsOptions {
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
  onTurnStalled: (
    sessionId: string,
    pendingSteers: PendingSteerPickup[],
  ) => Promise<void>;
}

export class OpenCodeStallWatchdogs {
  private readonly turnStallTimeoutMs: number;
  private readonly logger: OpenCodeStallWatchdogsLogger;
  private readonly isDisposed: () => boolean;
  private readonly isInFlight: () => boolean;
  private readonly getSessionId: () => string | undefined;
  private readonly hasDeferringActivity: () => boolean;
  private readonly verifyNoRunningTool: (
    sessionId: string,
  ) => Promise<TurnStallVerificationResult>;
  private readonly onTurnStalled: (
    sessionId: string,
    pendingSteers: PendingSteerPickup[],
  ) => Promise<void>;

  private pendingSteerPickups: PendingSteerPickup[] = [];
  private turnStallTimer: ReturnType<typeof setTimeout> | null = null;
  private lastTurnEventAtMs = 0;

  constructor(options: OpenCodeStallWatchdogsOptions) {
    this.turnStallTimeoutMs = options.turnStallTimeoutMs;
    this.logger = options.logger;
    this.isDisposed = options.isDisposed;
    this.isInFlight = options.isInFlight;
    this.getSessionId = options.getSessionId;
    this.hasDeferringActivity = options.hasDeferringActivity;
    this.verifyNoRunningTool = options.verifyNoRunningTool;
    this.onTurnStalled = options.onTurnStalled;
  }

  get turnStallTimeoutMsValue(): number {
    return this.turnStallTimeoutMs;
  }

  trackNativeSteer(steer: PendingSteerPickup): void {
    this.pendingSteerPickups.push(steer);
  }

  clearPendingNativeSteers(): void {
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
   * part activity, child-session activity). A live turn reaches its next loop
   * boundary and consumes any natively injected prompts on its own.
   */
  noteProgress(): void {
    this.noteActivity();
    this.clearPendingNativeSteers();
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

  /** End of turn / dispose — discard pending steers and disarm recovery. */
  clearAll(): void {
    this.clearPendingNativeSteers();
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

    if (this.hasDeferringActivity()) {
      this.scheduleTurnStallCheck(this.turnStallTimeoutMs);
      return;
    }

    const idleAfterVerifyMs = Date.now() - this.lastTurnEventAtMs;

    if (idleAfterVerifyMs < this.turnStallTimeoutMs) {
      this.scheduleTurnStallCheck(this.turnStallTimeoutMs - idleAfterVerifyMs);
      return;
    }

    const pendingSteers = this.pendingSteerPickups;
    this.pendingSteerPickups = [];
    await this.onTurnStalled(sessionId, pendingSteers);
  }
}
