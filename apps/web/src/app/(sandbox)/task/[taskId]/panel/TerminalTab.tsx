'use client';

import { forwardRef, useCallback, useImperativeHandle, useRef } from 'react';
import { Loader2, RefreshCcw, X } from '@/components/system';
import '@xterm/xterm/css/xterm.css';

import { Button } from '@/components/system';
import { ButtonGroup } from '@/components/system';

import { useSandboxConnection } from '../hooks/SandboxProvider';
import { type GetWebSocketUrl, useTerminal } from '../hooks/use-terminal';

export interface TerminalTabHandle {
  focus: () => void;
  clearScrollback: () => void;
}

interface TerminalTabProps {
  sessionId?: string;
  initialCommand?: string;
  backgroundColor?: string;
  onClose?: () => void;
  onSessionExit?: (exitCode: number) => void;
  onMessage?: (message: {
    type: string;
    data?: string;
    exitCode?: number;
    message?: string;
  }) => void;
}

export const TerminalTab = forwardRef<TerminalTabHandle, TerminalTabProps>(
  function TerminalTab(
    {
      sessionId,
      initialCommand,
      backgroundColor = '#101828',
      onClose,
      onSessionExit,
      onMessage,
    },
    ref,
  ) {
    const containerRef = useRef<HTMLDivElement>(null);
    const { sandboxUrl, sandboxToken } = useSandboxConnection();

    const getWebSocketUrl: GetWebSocketUrl = useCallback(
      (cols, rows) => {
        if (!sandboxUrl) {
          return null;
        }

        const host = sandboxUrl.replace(/^http/, 'ws');

        const params = new URLSearchParams({
          cols: String(cols),
          rows: String(rows),
        });

        if (sandboxToken) {
          params.set('token', sandboxToken);
        }

        if (sessionId) {
          params.set('sessionId', sessionId);
        }

        return `${host}/ws/terminal?${params}`;
      },
      [sandboxUrl, sandboxToken, sessionId],
    );

    const { disconnected, connecting, reconnect, clearScrollback, focus } =
      useTerminal(containerRef, getWebSocketUrl, {
        backgroundColor,
        initialInput: initialCommand ? `${initialCommand}\n` : undefined,
        onSessionExit,
        onMessage,
      });

    useImperativeHandle(ref, () => ({ focus, clearScrollback }), [
      clearScrollback,
      focus,
    ]);

    return (
      <div className="flex flex-col relative h-full w-full pt-2 pl-2">
        {disconnected || connecting ? (
          <div className="absolute top-2 right-2 z-10 flex items-center gap-2">
            {connecting ? (
              <Loader2 className="size-5 animate-spin text-white/60" />
            ) : (
              <ButtonGroup>
                <Button variant="outline" size="sm" onClick={reconnect}>
                  <RefreshCcw className="size-4" />
                  Reconnect
                </Button>
                {onClose && (
                  <Button variant="outline" size="sm" onClick={onClose}>
                    <X className="size-4" />
                    Close
                  </Button>
                )}
              </ButtonGroup>
            )}
          </div>
        ) : null}

        <div className="relative h-full w-full">
          <div ref={containerRef} className="absolute inset-0" />
        </div>
      </div>
    );
  },
);
