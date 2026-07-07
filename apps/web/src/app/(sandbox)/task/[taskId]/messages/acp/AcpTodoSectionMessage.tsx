import { Message, MessageContent } from '@/components/ai-elements';

import { useMemo } from 'react';

import { messageAnchorId } from '../message-anchor';
import type { AcpTodoSectionUiMessage } from './types';
import { ArrowRight } from 'lucide-react';

const TRANSITION_PHRASES = ['Starting', 'Moving to', 'Next up is'] as const;

interface AcpTodoSectionMessageProps {
  msg: AcpTodoSectionUiMessage;
}

export function AcpTodoSectionMessage({ msg }: AcpTodoSectionMessageProps) {
  const anchorId = messageAnchorId(msg.ts);

  const phrase = useMemo(() => {
    // Derive a stable index from the timestamp so the phrase doesn't change on re-render
    const hash = String(msg.ts)
      .split('')
      .reduce((acc: number, ch: string) => acc + ch.charCodeAt(0), 0);
    return TRANSITION_PHRASES[hash % TRANSITION_PHRASES.length];
  }, [msg.ts]);

  return (
    <Message from="assistant" className="chat-todo-section-message">
      <MessageContent id={anchorId} className="py-4">
        <div className="flex min-w-0 items-center gap-2">
          <ArrowRight className="size-3 text-foreground/30 shrink-0" />
          <p className="min-w-0 truncate text-sm font-medium text-muted-foreground">
            <span className="font-light">{phrase} </span>
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
