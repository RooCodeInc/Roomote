'use client';

import { useEffect, useState } from 'react';

import { sanitizeSandboxPathString } from '@/lib';
import { cn } from '@/lib/utils';
import { Button, SquareIcon } from '@/components/system';

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
  connected?: boolean;
  connectionWasEstablished?: boolean;
  canAbort?: boolean;
  abortPending?: boolean;
  onAbort?: () => void;
  showOutput?: boolean;
}

function formatCommandDuration(durationMs: number): string {
  const totalSeconds = Math.max(1, Math.floor(Math.max(0, durationMs) / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  }

  if (minutes > 0) {
    return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
  }

  return `${totalSeconds}s`;
}

export const AcpCommandOutputMessage = ({
  msg,
  ts,
  status = null,
  connected = true,
  connectionWasEstablished = false,
  canAbort = false,
  abortPending = false,
  onAbort,
  showOutput = false,
}: AcpCommandOutputMessageProps) => {
  const [now, setNow] = useState(() => Date.now());
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
  const hasOutput = output.trim().length > 0;
  const outputVisible = showOutput && hasOutput;

  const isExitCodePresent = cmd.exitCode !== undefined;
  const isPending =
    status === 'in_progress' || (status === null && !isExitCodePresent);
  const isFailed =
    status === 'failed' || (isExitCodePresent && cmd.exitCode !== 0);
  const isDisconnected = isPending && connectionWasEstablished && !connected;
  const startedAt = msg.startedAt ?? msg.ts;
  const duration =
    isPending || msg.startedAt !== undefined
      ? formatCommandDuration((isPending ? now : msg.ts) - startedAt)
      : null;
  const quietDuration = formatCommandDuration(now - msg.ts);

  useEffect(() => {
    if (!isPending || isDisconnected) {
      return;
    }

    const intervalId = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(intervalId);
  }, [isDisconnected, isPending]);

  const statusText = isDisconnected
    ? 'last known running · connection lost'
    : isPending
      ? now - msg.ts >= 15_000
        ? `running ${duration} · last update ${quietDuration} ago`
        : `running ${duration}`
      : isExitCodePresent
        ? cmd.exitCode === 0
          ? duration
            ? `completed in ${duration}`
            : null
          : duration
            ? `exit ${cmd.exitCode} · ${duration}`
            : `exit ${cmd.exitCode}`
        : status === 'failed'
          ? duration
            ? `failed · ${duration}`
            : 'failed'
          : null;

  return (
    <Message from="assistant" className={cn('chat-command-output-message')}>
      <MessageContent id={anchorId}>
        <CodeBlock
          code={output}
          language="bash"
          variant="compact"
          collapsible={outputVisible}
          defaultCollapsed={!isPending}
          renderContent={outputVisible}
          maxHeight={240}
          highlight={false}
          command={command ?? ''}
          showCommandCopy
          showOutputCopy={outputVisible}
        >
          <CodeBlockHeader className="w-full">
            <CodeBlockTitle>
              <CodeBlockCommand
                spinner={isPending && !isDisconnected}
                highlight={false}
                className="grow-0 basis-auto max-w-full"
              >
                {command ?? 'Terminal'}
              </CodeBlockCommand>
              {statusText && (
                <span
                  className={`mt-[5px] text-[11px] shrink-0 self-start font-mono select-none ${isFailed ? 'text-red-500' : 'text-muted-foreground/75'}`}
                >
                  → {statusText}
                </span>
              )}
              {isPending && canAbort && onAbort && (
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  className="mt-0.5 h-6 shrink-0 gap-1 px-1.5 font-sans text-[11px]"
                  disabled={abortPending}
                  onClick={(event) => {
                    event.stopPropagation();
                    onAbort();
                  }}
                  onKeyDown={(event) => event.stopPropagation()}
                >
                  <SquareIcon className="size-2.5 fill-current" />
                  {abortPending ? 'Stopping...' : 'Abort'}
                </Button>
              )}
            </CodeBlockTitle>
          </CodeBlockHeader>
        </CodeBlock>
      </MessageContent>
    </Message>
  );
};
