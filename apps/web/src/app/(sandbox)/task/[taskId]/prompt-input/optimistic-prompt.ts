import {
  type AcpMessage,
  type TaskMessageContentBlock,
  ACP_ENVELOPE_EVENT_TYPES,
  ROOMOTE_RUNTIME_TASK_MESSAGE_PROTOCOL,
} from '@roomote/types';

import type { TaskMessageEnvelope } from '@/types';

import type { QueuedMessage } from '../types';

type OptimisticPromptUserInfo = {
  userId?: string | null;
  userName?: string | null;
  userEmail?: string | null;
  userImageUrl?: string | null;
};

type OptimisticPromptInput = {
  taskId: string;
  prompt: string;
  images?: string[];
  goalObjective?: string;
  clientMessageId: string;
  currentUserInfo: OptimisticPromptUserInfo | null;
};

type OptimisticPromptArtifacts = {
  event: AcpMessage;
  envelope: TaskMessageEnvelope;
  queuedMessage: QueuedMessage;
};

function createPromptContentBlocks(text: string): TaskMessageContentBlock[] {
  return text.length > 0 ? [{ type: 'text', text }] : [];
}

export function createOptimisticPromptArtifacts({
  taskId,
  prompt,
  images,
  goalObjective,
  clientMessageId,
  currentUserInfo,
}: OptimisticPromptInput): OptimisticPromptArtifacts {
  const contentBlocks = createPromptContentBlocks(prompt);
  const content = contentBlocks[0] ?? null;
  const ts = Date.now();
  const event: AcpMessage = {
    id: `local:${clientMessageId}`,
    ts,
    eventType: ACP_ENVELOPE_EVENT_TYPES.UserPrompt,
    role: 'user',
    kind: 'text',
    contentBlocks,
    metadata: {
      optimistic: true,
      visibleInTranscript: true,
    },
    payload: {
      clientMessageId,
      prompt: contentBlocks,
      content,
      ...(images ? { images } : {}),
      ...(goalObjective
        ? { goal: { objective: goalObjective, generation: null } }
        : {}),
      ...(currentUserInfo?.userId ? { userId: currentUserInfo.userId } : {}),
      ...(currentUserInfo?.userName
        ? { userName: currentUserInfo.userName }
        : {}),
      ...(currentUserInfo?.userEmail
        ? { userEmail: currentUserInfo.userEmail }
        : {}),
      ...(currentUserInfo?.userImageUrl
        ? { userImageUrl: currentUserInfo.userImageUrl }
        : {}),
    },
    visibleInTranscript: true,
    text: prompt,
    ...(currentUserInfo?.userId ? { userId: currentUserInfo.userId } : {}),
    ...(currentUserInfo?.userName
      ? { userName: currentUserInfo.userName }
      : {}),
    ...(currentUserInfo?.userImageUrl
      ? { userImageUrl: currentUserInfo.userImageUrl }
      : {}),
  };

  return {
    event,
    envelope: {
      id: event.id,
      userId: currentUserInfo?.userId ?? null,
      userName: currentUserInfo?.userName ?? null,
      userEmail: currentUserInfo?.userEmail ?? null,
      userImageUrl: currentUserInfo?.userImageUrl ?? null,
      taskId,
      ts: event.ts,
      createdAt: event.ts,
      sequence: null,
      eventType: event.eventType,
      role: event.role,
      kind: event.kind,
      protocol: ROOMOTE_RUNTIME_TASK_MESSAGE_PROTOCOL,
      contentBlocks: event.contentBlocks,
      metadata: event.metadata,
      payload: event.payload,
      visibleInTranscript: event.visibleInTranscript,
      text: event.text,
    },
    queuedMessage: {
      id: event.id,
      text: prompt,
      ...(images ? { images } : {}),
      ...(currentUserInfo?.userName
        ? { userName: currentUserInfo.userName }
        : {}),
      ...(currentUserInfo?.userImageUrl
        ? { userImageUrl: currentUserInfo.userImageUrl }
        : {}),
      clientMessageId,
      timestamp: ts,
      optimistic: true,
    },
  };
}
