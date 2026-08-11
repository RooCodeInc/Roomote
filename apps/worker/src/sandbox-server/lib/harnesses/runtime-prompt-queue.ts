import {
  type AcpMessage,
  ACP_ENVELOPE_EVENT_TYPES,
  type TaskGoal,
} from '@roomote/types';

import type { QueuedPromptMessageSnapshot } from '../harness';

import { imageInputToPromptBlock } from './runtime-prompt-utils';

type QueuedPromptMessage = QueuedPromptMessageSnapshot;

type RuntimeQueuedPromptMessageSnapshot = Readonly<QueuedPromptMessage>;

type RuntimePromptQueueUpdateCause =
  | 'enqueue'
  | 'dequeue'
  | 'delete'
  | 'prioritize'
  | 'move'
  | 'replace'
  | 'clear'
  | 'restore';

interface RuntimePromptQueueCallbacks {
  getSessionId: () => string | undefined;
  getNextSequence: () => number;
  emitRuntimeOutput: (event: AcpMessage) => void;
}

function isHiddenPlatformPrompt(prompt: {
  queueOnly?: boolean;
  visibleInTranscript?: boolean;
}): boolean {
  return prompt.queueOnly === true || prompt.visibleInTranscript === false;
}

export class RuntimePromptQueue {
  private queuedMessages: QueuedPromptMessage[] = [];
  private queuedMessageIdCounter = 0;
  private readonly callbacks: RuntimePromptQueueCallbacks;

  constructor(callbacks: RuntimePromptQueueCallbacks) {
    this.callbacks = callbacks;
  }

  enqueue(prompt: {
    text: string;
    images?: string[];
    queueOnly?: boolean;
    visibleInTranscript?: boolean;
    userId?: string;
    userName?: string;
    userImageUrl?: string;
    clientMessageId?: string;
    goalContext?: TaskGoal;
  }): string {
    // Hidden platform follow-ups reuse one clientMessageId per logical
    // notification (e.g. the PR re-review prompt for a run), so a newer
    // enqueue supersedes the queued one instead of stacking duplicates.
    // User-visible messages are never replaced.
    const replaceIndex =
      isHiddenPlatformPrompt(prompt) && prompt.clientMessageId
        ? this.queuedMessages.findIndex(
            (message) =>
              isHiddenPlatformPrompt(message) &&
              message.clientMessageId === prompt.clientMessageId,
          )
        : -1;
    const existing =
      replaceIndex >= 0 ? this.queuedMessages[replaceIndex] : undefined;
    const queuedMessage = {
      id: existing?.id ?? `runtime-queued-${++this.queuedMessageIdCounter}`,
      text: prompt.text,
      images: prompt.images ? [...prompt.images] : undefined,
      queueOnly: prompt.queueOnly,
      visibleInTranscript: prompt.visibleInTranscript,
      userId: prompt.userId,
      userName: prompt.userName,
      userImageUrl: prompt.userImageUrl,
      clientMessageId: prompt.clientMessageId,
      goalContext: prompt.goalContext,
      timestamp: Date.now(),
    };

    if (replaceIndex >= 0) {
      this.queuedMessages[replaceIndex] = queuedMessage;
      this.emitUpdate('replace');
      return queuedMessage.id;
    }

    this.queuedMessages.push(queuedMessage);
    this.emitUpdate('enqueue');
    return queuedMessage.id;
  }

  dequeue(): QueuedPromptMessage | undefined {
    const next = this.queuedMessages.shift();

    if (next) {
      this.emitUpdate('dequeue');
    }

    return next;
  }

  peek(): QueuedPromptMessage | undefined {
    return this.queuedMessages[0];
  }

  hasQueuedMessages(): boolean {
    return this.queuedMessages.length > 0;
  }

  has(id: string): boolean {
    return this.queuedMessages.some((message) => message.id === id);
  }

  clear(): void {
    if (this.queuedMessages.length === 0) {
      return;
    }

    this.queuedMessages = [];
    this.emitUpdate('clear');
  }

  deleteById(id: string): boolean {
    const index = this.queuedMessages.findIndex((message) => message.id === id);

    if (index < 0) {
      return false;
    }

    this.queuedMessages.splice(index, 1);
    this.emitUpdate('delete');
    return true;
  }

  prioritize(id: string): boolean {
    const index = this.queuedMessages.findIndex((message) => message.id === id);

    if (index < 0) {
      return false;
    }

    if (index === 0) {
      return true;
    }

    const message = this.queuedMessages.splice(index, 1)[0];

    if (!message) {
      return false;
    }

    this.queuedMessages.unshift(message);
    this.emitUpdate('prioritize');
    return true;
  }

  move(id: string, targetId: string, position: 'before' | 'after'): boolean {
    if (id === targetId) {
      return true;
    }

    const sourceIndex = this.queuedMessages.findIndex(
      (message) => message.id === id,
    );
    const targetIndex = this.queuedMessages.findIndex(
      (message) => message.id === targetId,
    );

    if (sourceIndex < 0 || targetIndex < 0) {
      return false;
    }

    const nextQueue = [...this.queuedMessages];
    const [message] = nextQueue.splice(sourceIndex, 1);

    if (!message) {
      return false;
    }

    const nextTargetIndex = nextQueue.findIndex(
      (queuedMessage) => queuedMessage.id === targetId,
    );

    if (nextTargetIndex < 0) {
      return false;
    }

    const insertIndex =
      position === 'before' ? nextTargetIndex : nextTargetIndex + 1;

    nextQueue.splice(insertIndex, 0, message);

    const orderChanged = nextQueue.some(
      (queuedMessage, index) =>
        queuedMessage.id !== this.queuedMessages[index]?.id,
    );

    if (!orderChanged) {
      return true;
    }

    this.queuedMessages = nextQueue;
    this.emitUpdate('move');
    return true;
  }

  buildPromptBlocks(
    text: string,
    images?: string[],
  ): Array<Record<string, unknown>> {
    const promptBlocks: Array<Record<string, unknown>> = [];

    for (const image of images ?? []) {
      const imageBlock = imageInputToPromptBlock(image);

      if (imageBlock) {
        promptBlocks.push(imageBlock);
      }
    }

    if (text.trim().length > 0 || promptBlocks.length === 0) {
      promptBlocks.push({ type: 'text', text });
    }

    return promptBlocks;
  }

  snapshot(): RuntimeQueuedPromptMessageSnapshot[] {
    return this.queuedMessages.map((message) => ({ ...message }));
  }

  restore(
    messages: RuntimeQueuedPromptMessageSnapshot[],
    options?: { emitUpdate?: boolean },
  ): void {
    this.queuedMessages = messages.map((message) => ({
      id: message.id,
      text: message.text,
      ...(message.images ? { images: [...message.images] } : {}),
      ...(message.queueOnly ? { queueOnly: true } : {}),
      ...(message.visibleInTranscript !== undefined
        ? { visibleInTranscript: message.visibleInTranscript }
        : {}),
      ...(message.userId ? { userId: message.userId } : {}),
      ...(message.userName ? { userName: message.userName } : {}),
      ...(message.userImageUrl ? { userImageUrl: message.userImageUrl } : {}),
      ...(message.clientMessageId
        ? { clientMessageId: message.clientMessageId }
        : {}),
      ...(message.goalContext ? { goalContext: message.goalContext } : {}),
      timestamp: message.timestamp,
    }));
    this.queuedMessageIdCounter = this.queuedMessages.reduce(
      (maxId, message) => {
        const match = /^runtime-queued-(\d+)$/.exec(message.id);

        if (!match) {
          return maxId;
        }

        const parsedId = Number(match[1]);
        return Number.isFinite(parsedId) ? Math.max(maxId, parsedId) : maxId;
      },
      0,
    );

    if (options?.emitUpdate) {
      this.emitUpdate('restore');
    }
  }

  private emitUpdate(cause: RuntimePromptQueueUpdateCause): void {
    const sessionId = this.callbacks.getSessionId() ?? 'runtime-session';
    const sequence = this.callbacks.getNextSequence();

    const queue = this.queuedMessages
      .filter(
        (message) =>
          !message.queueOnly && message.visibleInTranscript !== false,
      )
      .map((message) => ({
        id: message.id,
        text: message.text,
        timestamp: message.timestamp,
        ...(message.images ? { images: message.images } : {}),
        ...(message.userName ? { userName: message.userName } : {}),
        ...(message.userImageUrl ? { userImageUrl: message.userImageUrl } : {}),
        ...(message.clientMessageId
          ? { clientMessageId: message.clientMessageId }
          : {}),
      }));

    const deliverableCount = this.queuedMessages.filter(
      (message) => !message.queueOnly,
    ).length;

    this.callbacks.emitRuntimeOutput({
      id: `${sessionId}:${sequence}`,
      ts: Date.now(),
      eventType: ACP_ENVELOPE_EVENT_TYPES.QueuedMessagesUpdate,
      role: null,
      kind: 'unknown',
      contentBlocks: [],
      metadata: { sessionId, sequence },
      payload: {
        queuedMessages: queue,
        deliverableCount,
        cause,
      },
    });
  }
}
