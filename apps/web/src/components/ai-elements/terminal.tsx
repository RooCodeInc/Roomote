'use client';

import {
  type HTMLAttributes,
  createContext,
  useContext,
  useEffect,
  useRef,
} from 'react';
import Ansi from 'ansi-to-react';
import { TerminalIcon, Trash2Icon } from '@/components/system';
import type { ButtonAsButtonProps } from '@/components/system/primitives/button';

import { cn } from '@/lib/utils';

import { Button, CopyIconButton } from '@/components/system';

interface TerminalContextType {
  output: string;
  isStreaming: boolean;
  autoScroll: boolean;
  onClear?: () => void;
}

const TerminalContext = createContext<TerminalContextType>({
  output: '',
  isStreaming: false,
  autoScroll: true,
});

type TerminalProps = HTMLAttributes<HTMLDivElement> & {
  output: string;
  isStreaming?: boolean;
  autoScroll?: boolean;
  onClear?: () => void;
};

export const Terminal = ({
  output,
  isStreaming = false,
  autoScroll = true,
  onClear,
  className,
  children,
  ...props
}: TerminalProps) => (
  <TerminalContext.Provider
    value={{ output, isStreaming, autoScroll, onClear }}
  >
    <div
      className={cn(
        'flex flex-col overflow-hidden rounded-lg border bg-zinc-950 text-zinc-100',
        className,
      )}
      {...props}
    >
      {children ?? (
        <>
          <TerminalHeader>
            <TerminalTitle />
            <div className="flex items-center gap-1">
              <TerminalStatus />
              <TerminalActions>
                <TerminalCopyButton />
                {onClear && <TerminalClearButton />}
              </TerminalActions>
            </div>
          </TerminalHeader>
          <TerminalContent />
        </>
      )}
    </div>
  </TerminalContext.Provider>
);

type TerminalHeaderProps = HTMLAttributes<HTMLDivElement>;

const TerminalHeader = ({
  className,
  children,
  ...props
}: TerminalHeaderProps) => (
  <div
    className={cn(
      'flex items-center justify-between border-zinc-800 border-b px-4 py-2',
      className,
    )}
    {...props}
  >
    {children}
  </div>
);

type TerminalTitleProps = HTMLAttributes<HTMLDivElement>;

const TerminalTitle = ({
  className,
  children,
  ...props
}: TerminalTitleProps) => (
  <div
    className={cn('flex items-center gap-2 text-sm text-zinc-400', className)}
    {...props}
  >
    <TerminalIcon className="size-4" />
    {children ?? 'Terminal'}
  </div>
);

type TerminalStatusProps = HTMLAttributes<HTMLDivElement>;

const TerminalStatus = ({
  className,
  children,
  ...props
}: TerminalStatusProps) => {
  const { isStreaming } = useContext(TerminalContext);

  if (!isStreaming) {
    return null;
  }

  return (
    <div
      className={cn('flex items-center gap-2 text-xs text-zinc-400', className)}
      {...props}
    >
      {children ?? (
        <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-zinc-400" />
      )}
    </div>
  );
};

type TerminalActionsProps = HTMLAttributes<HTMLDivElement>;

const TerminalActions = ({
  className,
  children,
  ...props
}: TerminalActionsProps) => (
  <div className={cn('flex items-center gap-1', className)} {...props}>
    {children}
  </div>
);

type TerminalCopyButtonProps = Omit<ButtonAsButtonProps, 'children'> & {
  onCopy?: () => void;
};

const TerminalCopyButton = ({
  onCopy,
  className,
  ...props
}: TerminalCopyButtonProps) => {
  const { output } = useContext(TerminalContext);

  return (
    <CopyIconButton
      content={output}
      onCopied={onCopy}
      className={cn(
        'size-7 shrink-0 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100',
        className,
      )}
      iconClassName="size-3.5"
      {...props}
    />
  );
};

type TerminalClearButtonProps = ButtonAsButtonProps;

const TerminalClearButton = ({
  children,
  className,
  ...props
}: TerminalClearButtonProps) => {
  const { onClear } = useContext(TerminalContext);

  if (!onClear) {
    return null;
  }

  return (
    <Button
      className={cn(
        'size-7 shrink-0 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100',
        className,
      )}
      onClick={onClear}
      size="icon"
      variant="ghost"
      {...props}
    >
      {children ?? <Trash2Icon size={14} />}
    </Button>
  );
};

type TerminalContentProps = HTMLAttributes<HTMLDivElement>;

const TerminalContent = ({
  className,
  children,
  ...props
}: TerminalContentProps) => {
  const { output, isStreaming, autoScroll } = useContext(TerminalContext);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (autoScroll && containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }
  }, [output, autoScroll]);

  return (
    <div
      className={cn(
        'max-h-96 overflow-auto p-4 font-mono text-sm leading-relaxed',
        className,
      )}
      ref={containerRef}
      {...props}
    >
      {children ?? (
        <pre className="whitespace-pre-wrap wrap-break-word">
          <Ansi>{output}</Ansi>
          {isStreaming && (
            <span className="ml-0.5 inline-block h-4 w-2 animate-pulse bg-zinc-100" />
          )}
        </pre>
      )}
    </div>
  );
};
