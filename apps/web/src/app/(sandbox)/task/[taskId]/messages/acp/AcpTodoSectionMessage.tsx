import { Message, MessageContent } from '@/components/ai-elements';

import { messageAnchorId } from '../message-anchor';
import type { AcpTodoSectionUiMessage } from './types';
import { ArrowRight } from 'lucide-react';

interface AcpTodoSectionMessageProps {
  msg: AcpTodoSectionUiMessage;
}

export function AcpTodoSectionMessage({ msg }: AcpTodoSectionMessageProps) {
  const anchorId = messageAnchorId(msg.ts);
  return (
    <Message from="assistant" className="chat-todo-section-message">
      <MessageContent id={anchorId} className="py-4">
        <div className="flex min-w-0 items-center gap-2 text-muted-foreground">
          <ArrowRight className="size-3 shrink-0" />
          <p className="min-w-0 truncate text-sm font-medium">
            <span className="font-light">Starting on </span>
            {msg.data.content}
          </p>
          <div
            aria-hidden="true"
            className="h-0.5 min-w-8 grow border-t-1 border-border dark:border-border/50 border-dashed relative top-0.5"
          />
        </div>
      </MessageContent>
    </Message>
  );
}
