import { redactSecrets } from '@roomote/communication/redact-secrets';
import {
  formatErrorForLog,
  formatSingleLineLog,
  resolveRoomoteDeployMarkerEnv,
} from '@roomote/types';

import type { FastAgentNativeToolName } from './fast-agent-native-tool-bridge';
import type {
  FastAgentConversation,
  FastAgentTurnSource,
} from './fast-agent-conversation';

const MAX_TERMINAL_ERROR_LENGTH = 4_000;

let activeFastAgentTurnCount = 0;

type FastAgentTurnDiagnosticsContext = {
  conversation: FastAgentConversation;
  currentMessageId?: string;
  hasImages: boolean;
  modelRole: 'primary' | 'small';
  turnSource: FastAgentTurnSource;
};

type FastAgentTurnDiagnosticsOptions = {
  deployMarker?: ReturnType<typeof resolveRoomoteDeployMarkerEnv>;
  logger?: Pick<Console, 'error' | 'info' | 'warn'>;
  now?: () => number;
};

type NativeToolStats = {
  count: number;
  totalDurationMs: number;
  maxDurationMs: number;
};

function formatTerminalError(error: unknown): string {
  const redacted = redactSecrets(formatErrorForLog(error));
  return redacted.length <= MAX_TERMINAL_ERROR_LENGTH
    ? redacted
    : `${redacted.slice(0, MAX_TERMINAL_ERROR_LENGTH - 1)}…`;
}

/**
 * Records one deployment-owned operational log for a Fast turn. This is not
 * anonymous product telemetry and does not itself export data from the process.
 * Keep this field set bounded: prompts, replies, tool arguments, tool results,
 * and integration payloads must never be added here.
 */
export class FastAgentTurnDiagnostics {
  private readonly deployMarker: ReturnType<
    typeof resolveRoomoteDeployMarkerEnv
  >;
  private readonly logger: Pick<Console, 'error' | 'info' | 'warn'>;
  private readonly now: () => number;
  private readonly processConcurrentTurnCountAtStart: number;
  private readonly turnStartedAt: number;
  private canonicalConversationId: string | null = null;
  private failureReason: string | undefined;
  private terminalError: unknown;
  private visibleReplyCount = 0;
  private resolvedModel: string | undefined;
  private inferenceQueuedAt: number | undefined;
  private inferenceStartedAt: number | undefined;
  private inferenceFinishedAt: number | undefined;
  private openCodeProviderRetryEventCount = 0;
  private firstOpenCodeProviderRetryElapsedMs: number | undefined;
  private lastOpenCodeProviderRetryElapsedMs: number | undefined;
  private lastOpenCodeProviderRetryAttempt: number | undefined;
  private roomoteInferenceRetryCount = 0;
  private nativeToolCallCount = 0;
  private readonly nativeToolStats: Partial<
    Record<FastAgentNativeToolName, NativeToolStats>
  > = {};
  private readonly activeNativeTools = new Map<
    FastAgentNativeToolName,
    number
  >();
  private failed = false;
  private finished = false;

  constructor(
    private readonly context: FastAgentTurnDiagnosticsContext,
    options: FastAgentTurnDiagnosticsOptions = {},
  ) {
    this.deployMarker = options.deployMarker ?? resolveRoomoteDeployMarkerEnv();
    this.logger = options.logger ?? console;
    this.now = options.now ?? Date.now;
    this.turnStartedAt = this.now();
    activeFastAgentTurnCount += 1;
    this.processConcurrentTurnCountAtStart = activeFastAgentTurnCount;
  }

  setCanonicalConversationId(conversationId: string): void {
    this.canonicalConversationId = conversationId;
  }

  recordVisibleReply(): void {
    this.visibleReplyCount += 1;
  }

  recordModelResolved(model: string): void {
    this.resolvedModel = model;
  }

  markInferenceQueued(): void {
    this.inferenceQueuedAt ??= this.now();
  }

  markInferenceStarted(): void {
    const startedAt = this.now();
    this.inferenceQueuedAt ??= startedAt;
    this.inferenceStartedAt ??= startedAt;
  }

  markInferenceFinished(): void {
    if (this.inferenceStartedAt !== undefined) {
      this.inferenceFinishedAt = this.now();
    }
  }

  recordOpenCodeProviderRetry(attempt: number): void {
    this.openCodeProviderRetryEventCount += 1;
    this.lastOpenCodeProviderRetryAttempt = attempt;

    if (this.inferenceStartedAt === undefined) {
      return;
    }

    const elapsedMs = this.now() - this.inferenceStartedAt;
    this.firstOpenCodeProviderRetryElapsedMs ??= elapsedMs;
    this.lastOpenCodeProviderRetryElapsedMs = elapsedMs;
  }

  recordRoomoteInferenceRetry(): void {
    this.roomoteInferenceRetryCount += 1;
  }

  recordNativeToolStarted(name: FastAgentNativeToolName): () => void {
    const toolStartedAt = this.now();
    this.nativeToolCallCount += 1;
    this.activeNativeTools.set(
      name,
      (this.activeNativeTools.get(name) ?? 0) + 1,
    );
    let completed = false;

    return () => {
      if (completed) return;
      completed = true;

      const durationMs = this.now() - toolStartedAt;
      const stats = this.nativeToolStats[name] ?? {
        count: 0,
        totalDurationMs: 0,
        maxDurationMs: 0,
      };
      stats.count += 1;
      stats.totalDurationMs += durationMs;
      stats.maxDurationMs = Math.max(stats.maxDurationMs, durationMs);
      this.nativeToolStats[name] = stats;

      const activeCount = (this.activeNativeTools.get(name) ?? 1) - 1;
      if (activeCount > 0) {
        this.activeNativeTools.set(name, activeCount);
      } else {
        this.activeNativeTools.delete(name);
      }
    };
  }

  recordFailure(reason: string, error: unknown): void {
    this.failed = true;
    this.failureReason = reason;
    this.terminalError = error;
  }

  finish(): void {
    if (this.finished) return;
    this.finished = true;

    const turnFinishedAt = this.now();
    activeFastAgentTurnCount -= 1;

    try {
      this.writeTerminalLog(turnFinishedAt);
    } catch (error) {
      try {
        this.logger.warn(
          `[Fast Agent] Failed to record turn diagnostics: ${formatTerminalError(error)}`,
        );
      } catch {
        // Diagnostics must never replace the Fast turn's product result.
      }
    }
  }

  private writeTerminalLog(turnFinishedAt: number): void {
    const completedNativeToolCallCount = Object.values(
      this.nativeToolStats,
    ).reduce((total, stats) => total + stats.count, 0);
    const preInferenceFinishedAt =
      this.inferenceQueuedAt ?? this.inferenceStartedAt ?? turnFinishedAt;
    const logMessage = formatSingleLineLog('[Fast Agent] Turn finished.', {
      surface: this.context.conversation.surface,
      workspaceId: this.context.conversation.workspaceId,
      conversationId: this.context.conversation.conversationId,
      messageId: this.context.currentMessageId,
      canonicalConversationId: this.canonicalConversationId,
      turnSource: this.context.turnSource,
      modelRole: this.context.modelRole,
      resolvedModel: this.resolvedModel,
      release: this.deployMarker.roomote_release,
      releaseSource: this.deployMarker.roomote_release_source,
      outcome: this.failed ? 'failure' : 'success',
      reason: this.failureReason,
      serviceDurationMs: turnFinishedAt - this.turnStartedAt,
      preInferenceDurationMs: preInferenceFinishedAt - this.turnStartedAt,
      conversationQueueDurationMs:
        this.inferenceQueuedAt !== undefined &&
        this.inferenceStartedAt !== undefined
          ? this.inferenceStartedAt - this.inferenceQueuedAt
          : undefined,
      inferenceDurationMs:
        this.inferenceStartedAt !== undefined &&
        this.inferenceFinishedAt !== undefined
          ? this.inferenceFinishedAt - this.inferenceStartedAt
          : undefined,
      postInferenceDurationMs:
        this.inferenceFinishedAt !== undefined
          ? turnFinishedAt - this.inferenceFinishedAt
          : undefined,
      processConcurrentTurnCountAtStart: this.processConcurrentTurnCountAtStart,
      openCodeProviderRetryEventCount: this.openCodeProviderRetryEventCount,
      firstOpenCodeProviderRetryElapsedMs:
        this.firstOpenCodeProviderRetryElapsedMs,
      lastOpenCodeProviderRetryElapsedMs:
        this.lastOpenCodeProviderRetryElapsedMs,
      lastOpenCodeProviderRetryAttempt: this.lastOpenCodeProviderRetryAttempt,
      roomoteInferenceRetryCount: this.roomoteInferenceRetryCount,
      nativeToolCallCount: this.nativeToolCallCount,
      completedNativeToolCallCount,
      nativeToolStats:
        completedNativeToolCallCount > 0 ? this.nativeToolStats : undefined,
      activeNativeToolCounts:
        this.activeNativeTools.size > 0
          ? Object.fromEntries(this.activeNativeTools)
          : undefined,
      visibleReplyCount: this.visibleReplyCount,
      hasImages: this.context.hasImages,
      error: this.failed ? formatTerminalError(this.terminalError) : undefined,
    });

    if (this.failed) {
      this.logger.error(logMessage);
    } else {
      this.logger.info(logMessage);
    }
  }
}
