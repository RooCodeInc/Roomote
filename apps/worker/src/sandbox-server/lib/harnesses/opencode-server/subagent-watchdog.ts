import { asBoolean, asRecord, asString } from '@roomote/types';

import type {
  OpenCodeEventPayload,
  OpenCodeMessageInfo,
  OpenCodeToolPart,
} from './types';

export const DEFAULT_SUBAGENT_TASK_TIMEOUT_MS = 30 * 60_000;
export const DEFAULT_SUBAGENT_TASK_INACTIVITY_TIMEOUT_MS = 3 * 60_000;

// Real OpenCode subagent spawns surface on the parent session as a `task`
// tool part whose state carries input.subagent_type and, once the child
// session exists, metadata.sessionId pointing at it. (`subtask` parts are a
// separate command-driven surface that never reports a status.)
const OPEN_CODE_SUBAGENT_TASK_TOOL_NAME = 'task';

const SUBAGENT_ACTIVITY_EMIT_INTERVAL_MS = 5_000;

type OpenCodeSubagentToolStatus = 'in_progress' | 'completed' | 'failed';

interface OpenCodeSubagentNormalizedToolPart {
  toolCallId: string;
  title: string;
  status: OpenCodeSubagentToolStatus;
  updatePayload: Record<string, unknown>;
}

interface ActiveOpenCodeSubagentWatchdog {
  sessionId: string;
  /** Background launches outlive the parent turn; turn finish must not disarm them. */
  background: boolean;
  messageId: string | undefined;
  toolCallId: string;
  title: string;
  agentType: string | null;
  childSessionId: string | null;
  startedAtMs: number;
  lastActivityAtMs: number;
  // Child tool calls observed in a non-terminal state. While any are in
  // flight the inactivity deadline is suspended: a silently running tool is
  // indistinguishable from a hung one by event flow alone. OpenCode's shell
  // tool bounds that state itself (default 2-minute timeout that kills the
  // command and emits a terminal tool event); other tool kinds (MCP calls,
  // webfetch, nested task spawns) are not self-bounding, so a hang inside
  // one falls back to the total timeout — a deliberate trade-off, since a
  // wrong kill of legitimate slow work is worse than a slow abort.
  activeChildToolCallIds: Set<string>;
  timer: ReturnType<typeof setTimeout>;
  updatePayload: Record<string, unknown>;
  activitySeenChildToolCallIds: Set<string>;
  activityLastAction: string | null;
  activityLastEmitAtMs: number;
}

interface OpenCodeSubagentWatchdogCallbacks {
  logger: {
    info: (message: string) => void;
    warn: (message: string) => void;
  };
  emitToolUpdate: (event: {
    sessionId: string;
    messageId?: string;
    toolCallId: string;
    toolName: string;
    status: 'in_progress';
    payload: Record<string, unknown>;
  }) => void;
  emitInferenceUsage: (
    info: OpenCodeMessageInfo,
    fallbackAgent?: string,
  ) => void;
  listChildSessions: (
    sessionId: string,
    signal: AbortSignal,
  ) => Promise<{ id: string }[]>;
  abortChildSession: (
    sessionId: string,
    signal: AbortSignal,
  ) => Promise<unknown>;
  getAbortSignal: () => AbortSignal;
}

function isTerminalOpenCodeToolStatus(
  status: OpenCodeSubagentToolStatus,
): boolean {
  return status === 'completed' || status === 'failed';
}

function normalizeOpenCodeToolStatus(
  status: string | undefined,
): OpenCodeSubagentToolStatus {
  switch (status) {
    case 'completed':
      return 'completed';
    case 'error':
    case 'failed':
    case 'cancelled':
    case 'canceled':
      return 'failed';
    default:
      return 'in_progress';
  }
}

export function isOpenCodeSubagentTaskTool(toolName: string): boolean {
  return toolName.toLowerCase() === OPEN_CODE_SUBAGENT_TASK_TOOL_NAME;
}

function extractOpenCodeTaskToolChildSessionId(
  toolPart: OpenCodeToolPart,
): string | null {
  const metadata = asRecord(toolPart.state?.metadata);

  // Background task launches report the child session id as `jobId`.
  return asString(metadata?.sessionId) ?? asString(metadata?.jobId) ?? null;
}

function isOpenCodeBackgroundTaskToolPart(toolPart: OpenCodeToolPart): boolean {
  return (
    asBoolean(asRecord(toolPart.state?.input)?.background) === true ||
    asBoolean(asRecord(toolPart.state?.metadata)?.background) === true
  );
}

function extractOpenCodeTaskToolAgentType(
  toolPart: OpenCodeToolPart,
): string | null {
  return asString(asRecord(toolPart.state?.input)?.subagent_type) ?? null;
}

/**
 * Absolute + inactivity watchdogs for OpenCode subagent (task) spawns.
 * Owns timer state, child-session activity folding, and sibling-aware expiry.
 */
export class OpenCodeSubagentWatchdog {
  private readonly active = new Map<string, ActiveOpenCodeSubagentWatchdog>();
  private readonly childSessionKeys = new Map<string, string>();
  private readonly recordedChildUsageMessageIds = new Set<string>();

  constructor(
    private readonly config: {
      taskTimeoutMs: number;
      inactivityTimeoutMs: number;
    },
    private readonly callbacks: OpenCodeSubagentWatchdogCallbacks,
  ) {}

  start(
    eventKey: string,
    input: {
      sessionId: string;
      messageId: string | undefined;
      toolCallId: string;
      title: string;
      agentType: string | null;
      childSessionId: string | null;
      background: boolean;
      updatePayload: Record<string, unknown>;
    },
  ): void {
    const existing = this.active.get(eventKey);

    if (existing) {
      // Keep the original timer, but pick up details (like the child session
      // id or the background flag) that only appear on later part updates. A
      // parent-side part update is itself a liveness signal for the spawn, so
      // refresh the inactivity clock alongside the details.
      existing.background = existing.background || input.background;
      existing.childSessionId = input.childSessionId ?? existing.childSessionId;
      existing.agentType = input.agentType ?? existing.agentType;
      existing.title = input.title;
      existing.updatePayload = input.updatePayload;
      existing.lastActivityAtMs = Date.now();
      if (existing.childSessionId) {
        this.childSessionKeys.set(existing.childSessionId, eventKey);
      }
      return;
    }

    const nowMs = Date.now();
    const watchdog: ActiveOpenCodeSubagentWatchdog = {
      sessionId: input.sessionId,
      background: input.background,
      messageId: input.messageId,
      toolCallId: input.toolCallId,
      title: input.title,
      agentType: input.agentType,
      childSessionId: input.childSessionId,
      startedAtMs: nowMs,
      lastActivityAtMs: nowMs,
      activeChildToolCallIds: new Set(),
      timer: this.armTimer(
        eventKey,
        Math.min(this.config.inactivityTimeoutMs, this.config.taskTimeoutMs),
      ),
      updatePayload: input.updatePayload,
      activitySeenChildToolCallIds: new Set(),
      activityLastAction: null,
      activityLastEmitAtMs: 0,
    };
    this.active.set(eventKey, watchdog);
    if (input.childSessionId) {
      this.childSessionKeys.set(input.childSessionId, eventKey);
    }
    this.callbacks.logger.info(
      `Armed OpenCode subagent watchdog timeoutMs=${this.config.taskTimeoutMs} inactivityTimeoutMs=${this.config.inactivityTimeoutMs} toolCallId=${input.toolCallId} agentType=${
        input.agentType ?? 'unknown'
      } childSessionId=${input.childSessionId ?? 'pending'}`,
    );
  }

  updateForToolPart(
    eventKey: string,
    toolPart: OpenCodeToolPart,
    normalized: OpenCodeSubagentNormalizedToolPart,
    context: { sessionId: string; messageId?: string },
  ): void {
    if (!isOpenCodeSubagentTaskTool(toolPart.tool ?? '')) {
      return;
    }

    if (isTerminalOpenCodeToolStatus(normalized.status)) {
      // A background launch's tool call completes immediately while the child
      // session keeps working, so a completed background part must keep the
      // watchdog armed (keyed to the child session) until the child session
      // goes idle or the timeout aborts it.
      if (
        normalized.status === 'completed' &&
        isOpenCodeBackgroundTaskToolPart(toolPart)
      ) {
        this.start(eventKey, {
          sessionId: context.sessionId,
          messageId: context.messageId,
          toolCallId: normalized.toolCallId,
          title: normalized.title,
          agentType: extractOpenCodeTaskToolAgentType(toolPart),
          childSessionId: extractOpenCodeTaskToolChildSessionId(toolPart),
          background: true,
          updatePayload: normalized.updatePayload,
        });
        return;
      }

      this.stop(eventKey);
      return;
    }

    this.start(eventKey, {
      sessionId: context.sessionId,
      messageId: context.messageId,
      toolCallId: normalized.toolCallId,
      title: normalized.title,
      agentType: extractOpenCodeTaskToolAgentType(toolPart),
      childSessionId: extractOpenCodeTaskToolChildSessionId(toolPart),
      background: isOpenCodeBackgroundTaskToolPart(toolPart),
      updatePayload: normalized.updatePayload,
    });
  }

  captureTerminalActivity(
    eventKey: string,
    toolPart: OpenCodeToolPart,
    normalized: OpenCodeSubagentNormalizedToolPart,
  ): Record<string, unknown> | null {
    if (
      !isOpenCodeSubagentTaskTool(toolPart.tool ?? '') ||
      !isTerminalOpenCodeToolStatus(normalized.status)
    ) {
      return null;
    }

    const watchdog = this.active.get(eventKey);

    if (!watchdog) {
      return null;
    }

    return {
      agentType: watchdog.agentType,
      lastAction: watchdog.activityLastAction,
      toolCallCount: watchdog.activitySeenChildToolCallIds.size,
      startedAtMs: watchdog.startedAtMs,
      elapsedMs: Date.now() - watchdog.startedAtMs,
      terminal: true,
    };
  }

  stop(eventKey: string): void {
    const watchdog = this.active.get(eventKey);

    if (!watchdog) {
      return;
    }

    clearTimeout(watchdog.timer);
    if (watchdog.childSessionId) {
      this.childSessionKeys.delete(watchdog.childSessionId);
    }
    this.active.delete(eventKey);
  }

  /**
   * True when `childSessionId` is currently tracked by a live watchdog. Used by
   * the expiry fallback to avoid aborting sibling subagents that are still
   * being independently monitored — a watchdog with an unknown child session id
   * must not take down healthy concurrent children of the shared parent
   * session.
   */
  isChildSessionOwned(childSessionId: string): boolean {
    const eventKey = this.childSessionKeys.get(childSessionId);

    return eventKey !== undefined && this.active.has(eventKey);
  }

  getEventKeyForChildSession(childSessionId: string): string | undefined {
    return this.childSessionKeys.get(childSessionId);
  }

  clearAll(options?: { keepBackgroundWatchdogs?: boolean }): void {
    for (const [eventKey, watchdog] of this.active) {
      if (options?.keepBackgroundWatchdogs && watchdog.background) {
        continue;
      }

      clearTimeout(watchdog.timer);
      this.active.delete(eventKey);
      if (watchdog.childSessionId) {
        this.childSessionKeys.delete(watchdog.childSessionId);
      }
    }
  }

  /**
   * Every event a known child session emits — streamed text, tool state,
   * message completion — counts as liveness for its spawn watchdog.
   */
  markSessionActivity(childSessionId: string): void {
    const eventKey = this.childSessionKeys.get(childSessionId);
    const watchdog = eventKey ? this.active.get(eventKey) : undefined;

    if (watchdog) {
      watchdog.lastActivityAtMs = Date.now();
    }
  }

  /**
   * Live activity for the inline subagent row: child-session tool events are
   * folded into throttled toolUpdate emissions on the parent spawn tool call.
   */
  handleChildSessionToolActivity(
    childSessionId: string,
    payload: OpenCodeEventPayload,
  ): void {
    const eventKey = this.childSessionKeys.get(childSessionId);
    const watchdog = eventKey ? this.active.get(eventKey) : undefined;

    if (!watchdog || payload.type !== 'message.part.updated') {
      return;
    }

    const part = asRecord(asRecord(payload.properties)?.part);

    if (!part || asString(part.type) !== 'tool') {
      return;
    }

    const childToolCallId = asString(part.callID) ?? asString(part.id);
    const childToolStatus = normalizeOpenCodeToolStatus(
      asString(asRecord(part.state)?.status),
    );

    if (childToolCallId) {
      watchdog.activitySeenChildToolCallIds.add(childToolCallId);
      // Track in-flight child tool calls so the inactivity deadline is only
      // enforced between tools, where silence is a strong wedge signal.
      if (isTerminalOpenCodeToolStatus(childToolStatus)) {
        watchdog.activeChildToolCallIds.delete(childToolCallId);
      } else {
        watchdog.activeChildToolCallIds.add(childToolCallId);
      }
    }

    const state = asRecord(part.state);
    const input = asRecord(state?.input);
    const action = [
      asString(part.tool),
      asString(input?.command) ??
        asString(input?.description) ??
        asString(state?.title) ??
        asString(input?.pattern) ??
        asString(input?.filePath),
    ]
      .filter(Boolean)
      .join(' ')
      .slice(0, 120);

    if (action) {
      watchdog.activityLastAction = action;
    }

    const nowMs = Date.now();

    if (
      nowMs - watchdog.activityLastEmitAtMs <
      SUBAGENT_ACTIVITY_EMIT_INTERVAL_MS
    ) {
      return;
    }

    watchdog.activityLastEmitAtMs = nowMs;
    this.callbacks.emitToolUpdate({
      sessionId: watchdog.sessionId,
      messageId: watchdog.messageId,
      toolCallId: watchdog.toolCallId,
      toolName: OPEN_CODE_SUBAGENT_TASK_TOOL_NAME,
      status: 'in_progress',
      payload: {
        ...watchdog.updatePayload,
        status: 'in_progress',
        running: true,
        progressKind: 'subagent_activity',
        subagentActivity: {
          agentType: watchdog.agentType,
          lastAction: watchdog.activityLastAction,
          toolCallCount: watchdog.activitySeenChildToolCallIds.size,
          startedAtMs: watchdog.startedAtMs,
          elapsedMs: nowMs - watchdog.startedAtMs,
        },
      },
    });
  }

  /**
   * Hidden accounting for subagent (child-session) turns: completed assistant
   * messages on child sessions never reach the main-session finalize path, so
   * emit their inference usage directly from the event payload.
   */
  handleChildSessionMessageUpdated(
    childSessionId: string,
    payload: OpenCodeEventPayload,
  ): void {
    if (payload.type !== 'message.updated') {
      return;
    }

    const info = asRecord(asRecord(payload.properties)?.info) as
      | (OpenCodeMessageInfo & Record<string, unknown>)
      | null;

    if (!info || !info.id || info.sessionID !== childSessionId) {
      return;
    }

    if (info.role !== 'assistant') {
      return;
    }

    if (!info.time?.completed) {
      return;
    }

    if (this.recordedChildUsageMessageIds.has(info.id)) {
      return;
    }

    this.recordedChildUsageMessageIds.add(info.id);
    this.callbacks.emitInferenceUsage(
      info,
      this.resolveChildSessionAgentType(childSessionId),
    );
  }

  resolveChildSessionAgentType(childSessionId: string): string | undefined {
    const eventKey = this.childSessionKeys.get(childSessionId);
    const watchdog = eventKey ? this.active.get(eventKey) : undefined;

    return watchdog?.agentType ?? undefined;
  }

  private armTimer(
    eventKey: string,
    delayMs: number,
  ): ReturnType<typeof setTimeout> {
    const timer = setTimeout(() => {
      void this.handleDeadline(eventKey);
    }, delayMs);
    timer.unref?.();
    return timer;
  }

  /**
   * Sliding-deadline check: the timer fires at the earliest possible expiry,
   * then either expires the watchdog or re-arms it for the remaining window.
   * Liveness comes from structured child-session events; the inactivity
   * deadline is only enforced while it is a strong signal — the child session
   * id is known and no child tool call is in flight.
   */
  private async handleDeadline(eventKey: string): Promise<void> {
    const watchdog = this.active.get(eventKey);

    if (!watchdog) {
      return;
    }

    const nowMs = Date.now();
    const elapsedMs = nowMs - watchdog.startedAtMs;
    const idleMs = nowMs - watchdog.lastActivityAtMs;

    if (elapsedMs >= this.config.taskTimeoutMs) {
      await this.expire(
        eventKey,
        watchdog,
        `exceeded the ${this.config.taskTimeoutMs}ms watchdog timeout (elapsed=${elapsedMs}ms)`,
      );
      return;
    }

    const idleEnforceable =
      watchdog.childSessionId !== null &&
      watchdog.activeChildToolCallIds.size === 0;

    if (idleEnforceable && idleMs >= this.config.inactivityTimeoutMs) {
      await this.expire(
        eventKey,
        watchdog,
        `stalled with no child-session events for ${idleMs}ms (inactivity limit ${this.config.inactivityTimeoutMs}ms, elapsed=${elapsedMs}ms)`,
      );
      return;
    }

    const remainingTotalMs = this.config.taskTimeoutMs - elapsedMs;
    const remainingIdleMs = idleEnforceable
      ? this.config.inactivityTimeoutMs - idleMs
      : this.config.inactivityTimeoutMs;

    watchdog.timer = this.armTimer(
      eventKey,
      Math.min(remainingTotalMs, remainingIdleMs),
    );
  }

  private async expire(
    eventKey: string,
    watchdog: ActiveOpenCodeSubagentWatchdog,
    reason: string,
  ): Promise<void> {
    this.stop(eventKey);
    this.callbacks.logger.warn(
      `OpenCode subagent run ${reason} toolCallId=${watchdog.toolCallId} agentType=${
        watchdog.agentType ?? 'unknown'
      } title=${watchdog.title}; aborting child sessions of sessionId=${watchdog.sessionId}`,
    );

    // Abort only the child (subagent) sessions — never the parent session.
    // Prefer the exact child session captured from the task tool part
    // metadata; fall back to listing all children, excluding siblings still
    // owned by a live watchdog.
    try {
      const signal = this.callbacks.getAbortSignal();
      const childSessionIds = watchdog.childSessionId
        ? [watchdog.childSessionId]
        : (await this.callbacks.listChildSessions(watchdog.sessionId, signal))
            .map((child) => child.id)
            .filter(
              (childSessionId) => !this.isChildSessionOwned(childSessionId),
            );

      for (const childSessionId of childSessionIds) {
        try {
          await this.callbacks.abortChildSession(childSessionId, signal);
          this.callbacks.logger.warn(
            `Aborted OpenCode child session ${childSessionId} after the subagent watchdog expired for toolCallId=${watchdog.toolCallId}`,
          );
        } catch (error) {
          this.callbacks.logger.warn(
            `Failed to abort OpenCode child session ${childSessionId} after the subagent watchdog expired: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      }
    } catch (error) {
      this.callbacks.logger.warn(
        `Failed to list OpenCode child sessions for sessionId=${watchdog.sessionId} after the subagent watchdog expired: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}
