import { asString } from '@roomote/types';

export const DEFAULT_EXECUTE_TOOL_PROGRESS_INITIAL_DELAY_MS = 15_000;
export const DEFAULT_EXECUTE_TOOL_PROGRESS_INTERVAL_MS = 30_000;

const MAX_PROGRESS_COMMAND_CHARS = 240;

export type OpenCodeProgressToolStatus = 'in_progress' | 'completed' | 'failed';

export interface OpenCodeExecuteToolProgressNormalizedPart {
  toolCallId: string;
  toolName: string;
  title: string;
  rawStatus: string | undefined;
  status: OpenCodeProgressToolStatus;
  callPayload: Record<string, unknown>;
  updatePayload: Record<string, unknown>;
  output: string;
  error: string | undefined;
}

interface ActiveOpenCodeExecuteToolProgress {
  sessionId: string;
  messageId?: string;
  toolCallId: string;
  toolName: string;
  title: string;
  command: string | null | undefined;
  payload: Record<string, unknown>;
  startedAtMs: number;
  timer: ReturnType<typeof setTimeout>;
}

export interface OpenCodeExecuteToolProgressCallbacks {
  emitToolUpdate: (event: {
    sessionId: string;
    messageId?: string;
    toolCallId: string;
    toolName: string;
    status: 'in_progress';
    output: string;
    payload: Record<string, unknown>;
  }) => void;
}

function isTerminalOpenCodeToolStatus(
  status: OpenCodeProgressToolStatus,
): boolean {
  return status === 'completed' || status === 'failed';
}

function truncateProgressCommand(command: string): string {
  if (command.length <= MAX_PROGRESS_COMMAND_CHARS) {
    return command;
  }

  return `${command.slice(0, MAX_PROGRESS_COMMAND_CHARS - 3)}...`;
}

function formatProgressElapsed(elapsedMs: number): string {
  const totalSeconds = Math.max(1, Math.round(elapsedMs / 1000));

  if (totalSeconds < 60) {
    return `${totalSeconds}s`;
  }

  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
}

function formatExecuteToolProgressOutput(
  progress: ActiveOpenCodeExecuteToolProgress,
  nowMs: number,
): string {
  const lines = [
    `Command still running for about ${formatProgressElapsed(
      nowMs - progress.startedAtMs,
    )}.`,
  ];

  if (progress.command) {
    lines.push(`Command: ${truncateProgressCommand(progress.command)}`);
  }

  lines.push('No command output has been reported yet.');

  return lines.join('\n');
}

/**
 * Heartbeats for long-running OpenCode execute tools (bash/shell) that have
 * not yet produced output. Owned maps and timeouts live here so the harness
 * only wires lifecycle and event emission.
 */
export class OpenCodeExecuteToolProgress {
  private readonly active = new Map<
    string,
    ActiveOpenCodeExecuteToolProgress
  >();

  constructor(
    private readonly config: {
      initialDelayMs: number;
      intervalMs: number;
    },
    private readonly callbacks: OpenCodeExecuteToolProgressCallbacks,
  ) {}

  update(
    eventKey: string,
    normalized: OpenCodeExecuteToolProgressNormalizedPart,
    context: {
      sessionId: string;
      messageId?: string;
    },
  ): void {
    if (normalized.callPayload.isExecute !== true) {
      this.stop(eventKey);
      return;
    }

    if (
      isTerminalOpenCodeToolStatus(normalized.status) ||
      normalized.output.length > 0 ||
      normalized.error
    ) {
      this.stop(eventKey);
      return;
    }

    if (normalized.rawStatus !== 'running') {
      return;
    }

    const existing = this.active.get(eventKey);

    if (existing) {
      existing.title = normalized.title;
      existing.command = asString(normalized.callPayload.command);
      existing.payload = normalized.updatePayload;
      return;
    }

    this.active.set(eventKey, {
      sessionId: context.sessionId,
      messageId: context.messageId,
      toolCallId: normalized.toolCallId,
      toolName: normalized.toolName,
      title: normalized.title,
      command: asString(normalized.callPayload.command),
      payload: normalized.updatePayload,
      startedAtMs: Date.now(),
      timer: this.schedule(eventKey, this.config.initialDelayMs),
    });
  }

  stop(eventKey: string): void {
    const progress = this.active.get(eventKey);

    if (!progress) {
      return;
    }

    clearTimeout(progress.timer);
    this.active.delete(eventKey);
  }

  clearAll(): void {
    for (const progress of this.active.values()) {
      clearTimeout(progress.timer);
    }

    this.active.clear();
  }

  private schedule(
    eventKey: string,
    delayMs: number,
  ): ReturnType<typeof setTimeout> {
    const timer = setTimeout(() => {
      this.emit(eventKey);
    }, delayMs);
    timer.unref?.();
    return timer;
  }

  private emit(eventKey: string): void {
    const progress = this.active.get(eventKey);

    if (!progress) {
      return;
    }

    const nowMs = Date.now();
    const output = formatExecuteToolProgressOutput(progress, nowMs);

    this.callbacks.emitToolUpdate({
      sessionId: progress.sessionId,
      messageId: progress.messageId,
      toolCallId: progress.toolCallId,
      toolName: progress.toolName,
      status: 'in_progress',
      output,
      payload: {
        ...progress.payload,
        status: 'in_progress',
        running: true,
        progressKind: 'execute_tool_heartbeat',
        progressStartedAtMs: progress.startedAtMs,
        progressElapsedMs: nowMs - progress.startedAtMs,
      },
    });

    progress.timer = this.schedule(eventKey, this.config.intervalMs);
  }
}
