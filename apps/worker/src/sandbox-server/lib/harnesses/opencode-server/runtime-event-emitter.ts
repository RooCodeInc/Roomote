import {
  ACP_LOGICAL_EVENT_ID_KEY,
  ACP_ENVELOPE_EVENT_TYPES,
  ACP_LIVE_EVENT_TYPES,
  TaskEventName,
  buildAcpLogicalEventId,
  inferAcpMessageKind,
  type AcpMessage,
  type AcpEventType,
  type AcpPlanTodo,
  type AcpRequestUserInputAnswers,
  type AcpRequestUserInputPayload,
  type AcpRequestUserInputResponsePayload,
  type TaskMessageContentBlock,
} from '@roomote/types';

import {
  RuntimeEnvelopeBuilder,
  type PersistableEnvelope,
} from '../../runtime-envelope-builder';
import { createImageContentBlocks } from '../runtime-content-blocks';

export class OpenCodeRuntimeEventEmitter extends RuntimeEnvelopeBuilder {
  private nextMessageId = 0;

  private withLogicalEventId<
    T extends {
      eventType: AcpEventType;
      metadata: Record<string, unknown> | null;
      payload: Record<string, unknown>;
    },
  >(
    event: T,
    identity: {
      sessionId: string | undefined;
      messageId?: string | null;
      toolCallId?: string | null;
    },
  ): T & { logicalEventId?: string } {
    const logicalEventId = buildAcpLogicalEventId({
      sessionId: identity.sessionId,
      turnId: identity.messageId,
      toolCallId: identity.toolCallId,
      eventType: event.eventType,
    });

    if (!logicalEventId) {
      return event;
    }

    return {
      ...event,
      logicalEventId,
      metadata: {
        ...(event.metadata ?? {}),
        [ACP_LOGICAL_EVENT_ID_KEY]: logicalEventId,
      },
      payload: {
        ...event.payload,
        [ACP_LOGICAL_EVENT_ID_KEY]: logicalEventId,
      },
    };
  }

  output(event: Omit<AcpMessage, 'id' | 'kind' | 'text'>): void {
    const text = event.contentBlocks
      .map((block) =>
        block.type === 'text' && typeof block.text === 'string'
          ? block.text
          : null,
      )
      .filter((chunk): chunk is string => chunk !== null)
      .join('\n');

    this.emitOutput({
      id: `opencode-server:${++this.nextMessageId}`,
      kind: inferAcpMessageKind(event.eventType),
      ...event,
      ...(text.length > 0 ? { text } : {}),
    } satisfies AcpMessage);
  }

  persist(envelope: PersistableEnvelope): void {
    this.emitPersisted(envelope);
  }

  outputAndPersist(envelope: PersistableEnvelope): void {
    this.output(envelope);
    this.persist(envelope);
  }

  userPrompt(options: {
    sessionId: string | undefined;
    text?: string;
    images?: string[];
    visibleInTranscript?: boolean;
    source?: string;
    userId?: string;
    userName?: string;
    userImageUrl?: string;
    clientMessageId?: string;
  }): void {
    const { sessionId } = options;

    if (!sessionId) {
      return;
    }

    const contentBlocks: TaskMessageContentBlock[] = [];

    if (typeof options.text === 'string' && options.text.length > 0) {
      contentBlocks.push({ type: 'text', text: options.text });
    }

    contentBlocks.push(...createImageContentBlocks(options.images));

    this.outputAndPersist(
      this.withLogicalEventId(
        {
          ts: this.nextTs(),
          eventType: ACP_ENVELOPE_EVENT_TYPES.UserPrompt,
          role: 'user',
          contentBlocks,
          metadata: {
            sessionId,
            ...(options.source ? { source: options.source } : {}),
            ...(options.userId ? { userId: options.userId } : {}),
            ...(options.userName ? { userName: options.userName } : {}),
            ...(options.userImageUrl
              ? { userImageUrl: options.userImageUrl }
              : {}),
            ...(options.clientMessageId
              ? { clientMessageId: options.clientMessageId }
              : {}),
          },
          payload: {
            sessionId,
            text: options.text ?? '',
            ...(options.images?.length ? { images: options.images } : {}),
            ...(options.source ? { source: options.source } : {}),
            ...(options.clientMessageId
              ? { clientMessageId: options.clientMessageId }
              : {}),
          },
          visibleInTranscript: options.visibleInTranscript,
        },
        {
          sessionId,
          messageId: options.clientMessageId,
        },
      ),
    );
  }

  assistantMessageChunk(options: {
    sessionId: string;
    messageId?: string;
    text: string;
  }): void {
    if (options.text.length === 0) {
      return;
    }

    this.output(
      this.withLogicalEventId(
        {
          ts: this.nextTs(),
          eventType: ACP_ENVELOPE_EVENT_TYPES.AssistantMessageChunk,
          role: 'assistant',
          contentBlocks: [{ type: 'text', text: options.text }],
          metadata: {
            sessionId: options.sessionId,
            ...(options.messageId ? { turnId: options.messageId } : {}),
          },
          payload: {
            sessionId: options.sessionId,
            ...(options.messageId ? { turnId: options.messageId } : {}),
            text: options.text,
          },
        },
        { sessionId: options.sessionId, messageId: options.messageId },
      ),
    );
  }

  assistantThoughtChunk(options: {
    sessionId: string;
    messageId?: string;
    text: string;
  }): void {
    if (options.text.length === 0) {
      return;
    }

    this.output(
      this.withLogicalEventId(
        {
          ts: this.nextTs(),
          eventType: ACP_ENVELOPE_EVENT_TYPES.AssistantThoughtChunk,
          role: 'assistant',
          contentBlocks: [{ type: 'text', text: options.text }],
          metadata: {
            sessionId: options.sessionId,
            ...(options.messageId ? { turnId: options.messageId } : {}),
          },
          payload: {
            sessionId: options.sessionId,
            ...(options.messageId ? { turnId: options.messageId } : {}),
            text: options.text,
          },
        },
        { sessionId: options.sessionId, messageId: options.messageId },
      ),
    );
  }

  assistantThought(options: {
    sessionId: string;
    messageId?: string;
    text: string;
    hadDelta?: boolean;
  }): void {
    if (options.text.length === 0) {
      return;
    }

    // Consolidated reasoning for the turn (persisted), mirroring the Codex
    // path's `AssistantThought`. The streaming `assistantThoughtChunk` events
    // are live-only; this is the single block the transcript renders.
    const envelope = this.withLogicalEventId(
      {
        ts: this.nextTs(),
        eventType: ACP_ENVELOPE_EVENT_TYPES.AssistantThought,
        role: 'assistant',
        contentBlocks: [{ type: 'text', text: options.text }],
        metadata: {
          sessionId: options.sessionId,
          ...(options.messageId ? { turnId: options.messageId } : {}),
        },
        payload: {
          sessionId: options.sessionId,
          ...(options.messageId ? { turnId: options.messageId } : {}),
          text: options.text,
        },
      } satisfies PersistableEnvelope,
      { sessionId: options.sessionId, messageId: options.messageId },
    );

    // When the reasoning already streamed as live `assistantThoughtChunk`
    // events, the transcript is showing the chunk-built block. Re-emitting the
    // consolidated thought on the live socket would render a duplicate
    // "Thought" block, so persist it without a live re-emit.
    if (options.hadDelta) {
      this.persist(envelope);
    } else {
      this.outputAndPersist(envelope);
    }
  }

  assistantMessage(options: {
    sessionId: string;
    messageId?: string;
    text: string;
    hadDelta?: boolean;
    payload?: Record<string, unknown>;
    metadata?: Record<string, unknown>;
  }): void {
    const envelope = this.withLogicalEventId(
      {
        ts: this.nextTs(),
        eventType: ACP_ENVELOPE_EVENT_TYPES.AssistantMessage,
        role: 'assistant',
        contentBlocks:
          options.text.length > 0 ? [{ type: 'text', text: options.text }] : [],
        metadata: {
          sessionId: options.sessionId,
          ...(options.messageId ? { turnId: options.messageId } : {}),
          ...(options.metadata ?? {}),
        },
        payload: {
          sessionId: options.sessionId,
          ...(options.messageId ? { turnId: options.messageId } : {}),
          text: options.text,
          ...(options.payload ?? {}),
        },
      } satisfies PersistableEnvelope,
      { sessionId: options.sessionId, messageId: options.messageId },
    );

    if (options.hadDelta) {
      this.persist(envelope);
    } else {
      this.outputAndPersist(envelope);
    }
  }

  requestUserInput(request: AcpRequestUserInputPayload & { ts: number }): void {
    this.outputAndPersist(
      this.withLogicalEventId(
        {
          ts: request.ts,
          eventType: ACP_ENVELOPE_EVENT_TYPES.RequestUserInput,
          role: 'assistant',
          contentBlocks: [],
          metadata: {
            sessionId: request.sessionId,
            turnId: request.turnId,
          },
          payload: request as unknown as Record<string, unknown>,
        },
        {
          sessionId: request.sessionId,
          messageId: request.turnId,
          toolCallId: request.callId,
        },
      ),
    );
  }

  requestUserInputResponse(options: {
    request: AcpRequestUserInputPayload;
    answers: AcpRequestUserInputAnswers;
    resolution: AcpRequestUserInputResponsePayload['resolution'];
  }): void {
    const payload = {
      requestId: options.request.requestId,
      sessionId: options.request.sessionId,
      turnId: options.request.turnId,
      callId: options.request.callId,
      answers: options.answers,
      resolution: options.resolution,
    };

    this.outputAndPersist(
      this.withLogicalEventId(
        {
          ts: this.nextTs(),
          eventType: ACP_ENVELOPE_EVENT_TYPES.RequestUserInputResponse,
          role: 'user',
          contentBlocks: [],
          metadata: {
            sessionId: options.request.sessionId,
            turnId: options.request.turnId,
          },
          payload,
        },
        {
          sessionId: options.request.sessionId,
          messageId: options.request.turnId,
          toolCallId: options.request.callId,
        },
      ),
    );
  }

  taskCancelled(options: {
    sessionId: string;
    cancelledByName?: string;
    source?: string;
  }): void {
    const ts = this.nextTs();
    const text = options.cancelledByName
      ? `Stopped by ${options.cancelledByName}`
      : 'Stopped';

    this.outputAndPersist(
      this.withLogicalEventId(
        {
          ts,
          eventType: ACP_ENVELOPE_EVENT_TYPES.TaskCancelled,
          role: 'system',
          contentBlocks: [{ type: 'text', text }],
          metadata: {
            sessionId: options.sessionId,
          },
          payload: {
            sessionId: options.sessionId,
            ...(options.cancelledByName
              ? { cancelledByName: options.cancelledByName }
              : {}),
            ...(options.source ? { source: options.source } : {}),
          },
        },
        // Each marker is its own logical transcript item; keying by the
        // envelope's own ts keeps repeated cancels in one session distinct
        // while the live emit and the persisted envelope still reconcile.
        { sessionId: options.sessionId, messageId: `cancel-${ts}` },
      ),
    );
  }

  plan(options: {
    sessionId: string;
    messageId?: string;
    toolCallId?: string;
    entries: AcpPlanTodo[];
  }): void {
    const text = options.entries
      .map((entry) => `- [${entry.status}] ${entry.content}`)
      .join('\n');

    this.outputAndPersist(
      this.withLogicalEventId(
        {
          ts: this.nextTs(),
          eventType: ACP_ENVELOPE_EVENT_TYPES.Plan,
          role: 'assistant',
          contentBlocks: text.length > 0 ? [{ type: 'text', text }] : [],
          metadata: {
            source: 'plan',
            sessionId: options.sessionId,
            ...(options.messageId ? { turnId: options.messageId } : {}),
          },
          payload: {
            entries: options.entries,
          },
        },
        {
          sessionId: options.sessionId,
          messageId: options.messageId,
          toolCallId: options.toolCallId,
        },
      ),
    );
  }

  toolCall(options: {
    sessionId: string;
    messageId?: string;
    toolCallId: string;
    title: string;
    status: string;
    payload: Record<string, unknown>;
    contentText?: string;
  }): void {
    const contentText = options.contentText ?? options.title;

    this.outputAndPersist(
      this.withLogicalEventId(
        {
          ts: this.nextTs(),
          eventType: ACP_ENVELOPE_EVENT_TYPES.ToolCall,
          role: 'assistant',
          contentBlocks:
            contentText.length > 0 ? [{ type: 'text', text: contentText }] : [],
          metadata: {
            sessionId: options.sessionId,
            ...(options.messageId ? { turnId: options.messageId } : {}),
            toolCallId: options.toolCallId,
            status: options.status,
          },
          payload: {
            sessionId: options.sessionId,
            ...(options.messageId ? { turnId: options.messageId } : {}),
            ...options.payload,
          },
        },
        {
          sessionId: options.sessionId,
          messageId: options.messageId,
          toolCallId: options.toolCallId,
        },
      ),
    );
  }

  toolUpdate(options: {
    sessionId: string;
    messageId?: string;
    toolCallId: string;
    toolName: string;
    status: string;
    input?: Record<string, unknown>;
    output?: string;
    error?: string;
    payload?: Record<string, unknown>;
  }): void {
    this.output(
      this.withLogicalEventId(
        {
          ts: this.nextTs(),
          eventType: ACP_ENVELOPE_EVENT_TYPES.ToolCallUpdate,
          role: 'tool',
          contentBlocks: options.output
            ? [{ type: 'text', text: options.output }]
            : [],
          metadata: {
            sessionId: options.sessionId,
            ...(options.messageId ? { turnId: options.messageId } : {}),
            toolCallId: options.toolCallId,
            status: options.status,
          },
          payload: {
            sessionId: options.sessionId,
            ...(options.messageId ? { turnId: options.messageId } : {}),
            toolCallId: options.toolCallId,
            name: options.toolName,
            status: options.status,
            ...(options.payload ? options.payload : {}),
            ...(options.input ? { input: options.input } : {}),
            ...(options.output ? { output: options.output } : {}),
            ...(options.error ? { error: options.error } : {}),
          },
        },
        {
          sessionId: options.sessionId,
          messageId: options.messageId,
          toolCallId: options.toolCallId,
        },
      ),
    );
  }

  toolResult(options: {
    sessionId: string;
    messageId?: string;
    toolCallId: string;
    status: string;
    output: string;
    payload: Record<string, unknown>;
  }): void {
    this.persist(
      this.withLogicalEventId(
        {
          ts: this.nextTs(),
          eventType: ACP_ENVELOPE_EVENT_TYPES.ToolResult,
          role: 'tool',
          contentBlocks:
            options.output.length > 0
              ? [{ type: 'text', text: options.output }]
              : [],
          metadata: {
            sessionId: options.sessionId,
            ...(options.messageId ? { turnId: options.messageId } : {}),
            toolCallId: options.toolCallId,
            status: options.status,
          },
          payload: {
            sessionId: options.sessionId,
            ...(options.messageId ? { turnId: options.messageId } : {}),
            ...options.payload,
          },
        },
        {
          sessionId: options.sessionId,
          messageId: options.messageId,
          toolCallId: options.toolCallId,
        },
      ),
    );
  }

  usageUpdate(options: {
    sessionId: string;
    messageId?: string;
    used: number;
    size: number;
  }): void {
    this.output(
      this.withLogicalEventId(
        {
          ts: this.nextTs(),
          eventType: ACP_LIVE_EVENT_TYPES.UsageUpdate,
          role: 'assistant',
          contentBlocks: [],
          metadata: {
            sessionId: options.sessionId,
            ...(options.messageId ? { turnId: options.messageId } : {}),
          },
          payload: {
            sessionId: options.sessionId,
            ...(options.messageId ? { turnId: options.messageId } : {}),
            sessionUpdate: 'usage_update',
            used: options.used,
            size: options.size,
          },
        },
        { sessionId: options.sessionId, messageId: options.messageId },
      ),
    );
  }

  turnCompleted(sessionId: string, text: string): void {
    this.emitTurnCompleted({
      sessionId,
      ts: this.nextTs(),
      text,
    });
  }

  taskStarted(taskId: string): void {
    this.emitTaskEvent({
      eventName: TaskEventName.TaskStarted,
      payload: [taskId],
    });
  }

  taskCompleted(
    taskId: string,
    tokenUsage: Record<string, unknown> | undefined,
  ): void {
    const completionId = `${taskId}:${this.nextTs()}`;
    this.emitTaskEvent({
      eventName: TaskEventName.TaskCompleted,
      payload: [
        taskId,
        {
          totalTokensIn: Number(tokenUsage?.inputTokens ?? 0),
          totalTokensOut: Number(tokenUsage?.outputTokens ?? 0),
          totalCacheReads: Number(tokenUsage?.cachedInputTokens ?? 0),
          totalCacheWrites: Number(tokenUsage?.cacheWriteTokens ?? 0),
          totalCost: Number(tokenUsage?.costUsd ?? 0),
          contextTokens: Number(tokenUsage?.contextTokens ?? 0),
        },
        {},
        { isSubtask: false, completionId },
      ],
    });
  }

  taskAborted(taskId: string): void {
    this.emitTaskEvent({
      eventName: TaskEventName.TaskAborted,
      payload: [taskId],
    });
  }
}
