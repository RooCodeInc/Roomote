'use client';

import { ASCIISpinner } from '@/components/system';
import { Message, MessageContent } from '@/components/ai-elements';

import { type SandboxLogEntry, STARTUP_HIDDEN_PREFIXES } from '@roomote/types';

import { cn } from '@/lib/utils';

/**
 * Returns true when a log entry is an internal operational message that
 * should be hidden from end users in the Startup UI. These lines are still
 * captured in the raw sandbox logs for developer inspection.
 */
function isInternalLog(log: SandboxLogEntry): boolean {
  return STARTUP_HIDDEN_PREFIXES.some((prefix) => log.data.startsWith(prefix));
}

interface SandboxLogsTerminalProps {
  logs: SandboxLogEntry[];
  isConnected: boolean;
  error: string | null;
  className?: string;
  loadingMessage?: string;
}

export function SandboxLogsTerminal({
  logs,
  isConnected,
  error,
  className,
  loadingMessage = 'Connecting pipes...',
}: SandboxLogsTerminalProps) {
  const visibleLogs = logs.filter((log) => !isInternalLog(log));

  if (visibleLogs.length === 0 && !isConnected && !error) {
    return null;
  }

  return (
    <Message
      from="assistant"
      className={cn('chat-command-output-message hidden debug:flex', className)}
    >
      <MessageContent>
        <div className="font-mono font-light text-xs leading-5 py-1">
          {visibleLogs.length === 0 ? (
            <span className="">{loadingMessage}</span>
          ) : (
            visibleLogs.map((log, index) => (
              <div
                key={index}
                className={cn(
                  'whitespace-pre-wrap break-all',
                  log.stream === 'stderr' && 'text-red-400!',
                )}
              >
                {log.data}
              </div>
            ))
          )}
          {error && <div className="text-red-400 mt-2">Error: {error}</div>}
          {isConnected && (
            <div className="whitespace-pre-wrap break-all">
              <ASCIISpinner />
            </div>
          )}
        </div>
      </MessageContent>
    </Message>
  );
}
