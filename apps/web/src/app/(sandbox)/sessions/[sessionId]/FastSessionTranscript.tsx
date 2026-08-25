'use client';

import type { ReactNode } from 'react';

import type { FastSessionTranscriptMessage } from '@/lib/server/fast-sessions';
import {
  Conversation,
  ConversationContent,
  ConversationScrollButton,
  Message,
  MessageActions,
  MessageContent,
  MessageCopyButton,
  MessageNewTaskButton,
  MessagePlainText,
  MessageResponse,
  MessageUiOptionsProvider,
} from '@/components/ai-elements';
import { cn } from '@/lib/utils';

export function FastSessionTranscript({
  messages,
  footer,
}: {
  messages: FastSessionTranscriptMessage[];
  footer?: ReactNode;
}) {
  return (
    <MessageUiOptionsProvider>
      <Conversation className="min-h-0 flex-1" initial="instant">
        <ConversationContent className="ph-no-capture mx-auto w-full max-w-4xl p-4">
          {messages.map((message) => {
            const isUser = message.role === 'user';

            return (
              <Message key={message.id} from={message.role}>
                <MessageContent
                  className={cn('min-w-0 flex-1', isUser ? 'pt-8' : 'py-0')}
                >
                  {isUser ? (
                    <MessagePlainText>{message.text}</MessagePlainText>
                  ) : (
                    <MessageResponse>{message.text}</MessageResponse>
                  )}
                </MessageContent>
                <MessageActions className={isUser ? 'justify-end' : undefined}>
                  <MessageCopyButton content={message.text} />
                  <MessageNewTaskButton content={message.text} />
                </MessageActions>
              </Message>
            );
          })}
          {footer}
        </ConversationContent>
        <ConversationScrollButton />
      </Conversation>
    </MessageUiOptionsProvider>
  );
}
