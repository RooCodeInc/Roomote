import { sanitizeSandboxPathString } from '@/lib';
import { cn } from '@/lib/utils';

import {
  CodeBlock,
  CodeBlockCommand,
  CodeBlockHeader,
  CodeBlockTitle,
  Message,
  MessageContent,
} from '@/components/ai-elements';

import { messageAnchorId } from '../message-anchor';

import type { AcpToolCallUiMessage, AcpToolResultUiMessage } from './types';

type AcpCommandStatus = 'in_progress' | 'completed' | 'failed' | null;

interface AcpCommandOutputMessageProps {
  msg: AcpToolCallUiMessage | AcpToolResultUiMessage;
  ts?: number;
  status?: AcpCommandStatus;
}

export const AcpCommandOutputMessage = ({
  msg,
  ts,
  status = null,
}: AcpCommandOutputMessageProps) => {
  const cmd =
    msg.kind === 'tool_result'
      ? {
          command: msg.data.command ?? undefined,
          text: msg.text ?? msg.data.output ?? '',
          ...(msg.data.exitCode !== null
            ? { exitCode: msg.data.exitCode }
            : {}),
        }
      : { command: msg.data.command ?? undefined, text: msg.text ?? '' };

  const anchorId = ts === undefined ? undefined : messageAnchorId(ts);

  const command = cmd.command
    ? sanitizeSandboxPathString(cmd.command)
    : undefined;

  const output = sanitizeSandboxPathString(cmd.text);

  const isExitCodePresent = cmd.exitCode !== undefined;
  const isPending =
    status === 'in_progress' || (status === null && !isExitCodePresent);

  return (
    <Message from="assistant" className={cn('chat-command-output-message')}>
      <MessageContent id={anchorId}>
        <CodeBlock
          code={output}
          language="bash"
          variant="compact"
          collapsible={false}
          defaultCollapsed={false}
          forceDark={true}
          renderContent={false}
          maxHeight={undefined}
          command={command ?? ''}
          showCommandCopy
          showOutputCopy={false}
        >
          <CodeBlockHeader className="w-full">
            <CodeBlockTitle>
              <CodeBlockCommand
                spinner={isPending}
                highlight={false}
                className="grow-0 basis-auto max-w-full"
              >
                {command ?? 'Terminal'}
              </CodeBlockCommand>
            </CodeBlockTitle>
          </CodeBlockHeader>
        </CodeBlock>
      </MessageContent>
    </Message>
  );
};
