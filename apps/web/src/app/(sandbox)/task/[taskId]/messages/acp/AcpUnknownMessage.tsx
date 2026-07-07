import {
  CodeBlock,
  Message,
  MessageActions,
  MessageContent,
  MessageTimestamp,
} from '@/components/ai-elements';
import { cn } from '@/lib/utils';

import { useInternalTranscriptRowsVisible } from '../../useInternalTranscriptRowsVisible';
import { messageAnchorId } from '../message-anchor';
import type { AcpUiMessage } from './types';

interface AcpUnknownMessageProps {
  msg: AcpUiMessage;
}

export function AcpUnknownMessage({ msg }: AcpUnknownMessageProps) {
  const showPersistentTimestamp = useInternalTranscriptRowsVisible();
  const anchorId = messageAnchorId(msg.ts);
  const serialized = JSON.stringify(msg.data, null, 2);

  return (
    <Message from="assistant">
      <MessageContent id={anchorId}>
        <div className="text-xs text-muted-foreground pb-1">
          Runtime update: {msg.updateType}
        </div>
        <CodeBlock code={serialized} language="json" />
      </MessageContent>
      <MessageActions
        className={cn(showPersistentTimestamp && 'md:opacity-100')}
      >
        <MessageTimestamp
          ts={msg.ts}
          previousTs={msg.previousTs}
          anchorId={anchorId}
        />
      </MessageActions>
    </Message>
  );
}
