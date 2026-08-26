'use client';

import { useMemo, type ReactNode } from 'react';
import {
  getTextFromContentBlocks,
  inferAcpMessageKind,
  type AcpEventType,
} from '@roomote/types';

import type { FastSessionMessage } from '@/lib/server/fast-sessions';
import {
  Conversation,
  ConversationContent,
  ConversationScrollButton,
  MessageUiOptionsProvider,
} from '@/components/ai-elements';

import {
  AcpTranscriptBlockList,
  useAcpTranscriptBlocks,
} from '../../task/[taskId]/messages/acp';
import { toAcpUiMessage } from '../../task/[taskId]/hooks/services/acp-protocol-service';

export function FastSessionTranscript({
  messages,
  header,
  footer,
}: {
  messages: FastSessionMessage[];
  header?: ReactNode;
  footer?: ReactNode;
}) {
  const uiMessages = useMemo(
    () =>
      messages.map((message) =>
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
  const { renderBlocks, suppressMessage } = useAcpTranscriptBlocks({
    messages: uiMessages,
    artifacts: [],
    displayMode: 'default',
    initialPrompt: null,
    shouldHideFirstMessage: false,
    showInternalMessages: false,
    hasLeadingTextBoundary: false,
    resetKey: `${messages.length}:${messages[0]?.eventId ?? ''}:${messages.at(-1)?.eventId ?? ''}`,
  });

  return (
    <MessageUiOptionsProvider>
      <Conversation className="min-h-0 flex-1" initial="instant">
        <ConversationContent className="ph-no-capture mx-auto w-full max-w-4xl p-4">
          {header}
          <AcpTranscriptBlockList
            blocks={renderBlocks}
            showInternalMessages={false}
            onSuppress={suppressMessage}
          />
          {footer}
        </ConversationContent>
        <ConversationScrollButton />
      </Conversation>
    </MessageUiOptionsProvider>
  );
}
