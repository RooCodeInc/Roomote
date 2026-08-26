import { memo, type ReactNode } from 'react';

import type { AcpUiMessage } from './types';
import { AcpCommandOutputMessage } from './AcpCommandOutputMessage';
import { AcpReasoningMessage } from './AcpReasoningMessage';
import { AcpTaskCancelledMessage } from './AcpTaskCancelledMessage';
import { AcpTodoSectionMessage } from './AcpTodoSectionMessage';
import { AcpTextMessage } from './AcpTextMessage';
import { AcpToolMessage } from './AcpToolMessage';
import { AcpUnknownMessage } from './AcpUnknownMessage';
import { DelegatedTaskCard } from './DelegatedTaskCard';
import { getDelegatedTaskDetails } from './delegated-task';

interface AcpMessageItemProps {
  msg: AcpUiMessage;
  onSuppress?: (messageId: string) => void;
  showSubagentPayload?: boolean;
  onOpenDelegatedTask?: (taskId: string) => void;
  children?: ReactNode;
}

function AcpMessageItemBase({
  msg,
  onSuppress,
  showSubagentPayload = false,
  onOpenDelegatedTask,
  children,
}: AcpMessageItemProps) {
  switch (msg.kind) {
    case 'text':
      return <AcpTextMessage msg={msg} />;
    case 'reasoning':
      return <AcpReasoningMessage msg={msg} onSuppress={onSuppress} />;
    case 'todo_section':
      return <AcpTodoSectionMessage msg={msg} />;
    case 'tool_call':
    case 'tool_result': {
      const delegatedTask = getDelegatedTaskDetails(msg);

      if (delegatedTask && onOpenDelegatedTask) {
        return (
          <DelegatedTaskCard {...delegatedTask} onOpen={onOpenDelegatedTask} />
        );
      }

      return msg.data.kind === 'execute' ? (
        <AcpCommandOutputMessage
          msg={msg}
          ts={msg.ts}
          status={msg.data.status}
        />
      ) : (
        <AcpToolMessage msg={msg} showSubagentPayload={showSubagentPayload}>
          {children}
        </AcpToolMessage>
      );
    }
    case 'plan':
      // Displayed in the header.
      return null;
    case 'task_cancelled':
      return <AcpTaskCancelledMessage msg={msg} />;
    default:
      return <AcpUnknownMessage msg={msg} />;
  }
}

export const AcpMessageItem = memo(AcpMessageItemBase);

AcpMessageItem.displayName = 'AcpMessageItem';
