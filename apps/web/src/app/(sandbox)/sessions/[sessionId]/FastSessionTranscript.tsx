'use client';

import { useMemo, type ReactNode } from 'react';
import {
  getTextFromContentBlocks,
  inferAcpMessageKind,
  isVisibleInTranscript,
  type AcpEventType,
} from '@roomote/types';

import type { FastSessionMessage } from '@/lib/server/fast-sessions';
import {
  Conversation,
  ConversationContent,
  ConversationScrollButton,
  MessageUiOptionsProvider,
} from '@/components/ai-elements';

import { AcpMessageItem } from '../../task/[taskId]/messages/acp';
import { toAcpUiMessage } from '../../task/[taskId]/hooks/services/acp-protocol-service';

export function FastSessionTranscript({
  messages,
  footer,
}: {
  messages: FastSessionMessage[];
  footer?: ReactNode;
}) {
  const uiMessages = useMemo(
    () =>
      messages
        .filter((message) => isVisibleInTranscript(message.metadata))
        .map((message) =>
          toAcpUiMessage({
            id: message.id,
            ts: message.ts,
            eventType: message.eventType as AcpEventType,
            role: message.role,
            kind: inferAcpMessageKind(message.eventType),
            contentBlocks: message.contentBlocks,
            metadata: message.metadata,
            payload: message.payload,
            text: getTextFromContentBlocks(message.contentBlocks) ?? undefined,
          }),
        ),
    [messages],
  );

  return (
    <MessageUiOptionsProvider>
      <Conversation className="min-h-0 flex-1" initial="instant">
        <ConversationContent className="ph-no-capture mx-auto w-full max-w-4xl p-4">
          {uiMessages.map((message) => (
            <AcpMessageItem key={message.id} msg={message} />
          ))}
          {footer}
        </ConversationContent>
        <ConversationScrollButton />
      </Conversation>
    </MessageUiOptionsProvider>
  );
}
