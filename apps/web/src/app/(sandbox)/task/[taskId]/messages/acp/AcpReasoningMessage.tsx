import { memo, useState } from 'react';

import {
  Message,
  MessageContent,
  Reasoning,
  ReasoningContent,
  ReasoningTrigger,
} from '@/components/ai-elements';
import { useMessageUiOptions } from '@/components/ai-elements/message-ui-options';
import { Lightbulb } from '@/components/system';

import {
  useInitialSandboxReasoningExpanded,
  useSandboxSetReasoningExpanded,
} from '../../hooks/SandboxProvider';
import { messageAnchorId } from '../message-anchor';

import type { AcpUiMessage } from './types';

interface AcpReasoningMessageProps {
  msg: AcpUiMessage;
  onSuppress?: (messageId: string) => void;
}

const AcpReasoningMessageBase = ({
  msg,
  onSuppress: _onSuppress,
}: AcpReasoningMessageProps) => {
  const anchorId = messageAnchorId(msg.ts);
  const { displayMode = 'default', expandReasoningByDefault = false } =
    useMessageUiOptions();
  const initialExpanded = useInitialSandboxReasoningExpanded();
  const setReasoningExpanded = useSandboxSetReasoningExpanded();

  const [openOverride, setOpenOverride] = useState<boolean | null>(
    initialExpanded,
  );
  const isOpen = openOverride ?? expandReasoningByDefault;

  const handleOpenChange = (open: boolean) => {
    setOpenOverride(open);
    setReasoningExpanded(open);
  };

  if (displayMode === 'narration') {
    return (
      <Message from="assistant" className="chat-reasoning-message">
        <MessageContent id={anchorId}>
          <div className="space-y-2">
            <div className="flex items-center gap-2 text-sm font-light text-muted-foreground">
              <Lightbulb className="size-4" />
              <span>Thought</span>
            </div>
            <Reasoning
              isStreaming={msg.partial}
              open={true}
              defaultOpen={false}
            >
              <ReasoningContent className="mb-0 mt-0">
                {msg.text ?? ''}
              </ReasoningContent>
            </Reasoning>
          </div>
        </MessageContent>
      </Message>
    );
  }

  return (
    <Message from="assistant" className="chat-reasoning-message">
      <MessageContent id={anchorId}>
        <Reasoning
          isStreaming={msg.partial}
          open={isOpen}
          defaultOpen={false}
          onOpenChange={handleOpenChange}
        >
          <ReasoningTrigger />
          <ReasoningContent>{msg.text ?? ''}</ReasoningContent>
        </Reasoning>
      </MessageContent>
    </Message>
  );
};

export const AcpReasoningMessage = memo(AcpReasoningMessageBase);

AcpReasoningMessage.displayName = 'AcpReasoningMessage';
