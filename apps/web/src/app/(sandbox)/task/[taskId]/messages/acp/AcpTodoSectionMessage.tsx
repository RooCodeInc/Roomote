import { Message, MessageContent } from '@/components/ai-elements';

import { messageAnchorId } from '../message-anchor';
import type { AcpTodoSectionUiMessage } from './types';
import { ArrowRight, CheckSquare, SquareDashed } from 'lucide-react';

interface AcpTodoSectionMessageProps {
  msg: AcpTodoSectionUiMessage;
}

export function AcpTodoSectionMessage({ msg }: AcpTodoSectionMessageProps) {
  const anchorId = messageAnchorId(msg.ts);
  return (
    <Message from="assistant" className="chat-todo-section-message">
      <MessageContent id={anchorId} className="cursor-default">
        <div className="flex min-w-0 items-center gap-2 text-muted-foreground">
          <p className="min-w-0 truncate text-sm font-medium">
            <SquareDashed className="inline size-3 mr-2" />
            <span className="font-light">Starting on </span>
            {msg.data.content}
          </p>
          <div
            aria-hidden="true"
            className="h-0.5 min-w-8 grow border-t border-border relative top-0.5"
          />
        </div>
      </MessageContent>
    </Message>
  );
}
