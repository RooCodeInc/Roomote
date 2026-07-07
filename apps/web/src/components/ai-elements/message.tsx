'use client';

import {
  type ComponentProps,
  type HTMLAttributes,
  type ReactElement,
  createContext,
  memo,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';
import * as React from 'react';
import type { UIMessage } from 'ai';
import { format, formatDuration, intervalToDuration, isToday } from 'date-fns';
import { Streamdown, defaultRemarkPlugins } from 'streamdown';
import remarkBreaks from 'remark-breaks';
import type { ButtonAsButtonProps } from '@/components/system/primitives/button';

import { cn } from '@/lib/utils';

import {
  ArrowUpRightIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  Button,
  ButtonGroup,
  ButtonGroupText,
  CopyIconButton,
  BasicTooltip,
} from '@/components/system';
import { CustomLink, remarkArtifactLinks } from '@/components/ai-elements';
import { useMessageUiOptions } from '@/components/ai-elements/message-ui-options';
import { remarkAutolinkUrls } from '@/components/ai-elements/remark-autolink-urls';
import { streamdownPlugins } from '@/components/ai-elements/streamdown-plugins';

type MessageProps = HTMLAttributes<HTMLDivElement> & {
  from: UIMessage['role'];
};

export const Message = ({
  className,
  from,
  children,
  ...props
}: MessageProps) => (
  <div
    className={cn(
      'group relative flex w-full flex-col justify-start',
      'animate-enter-message',
      'chat-message',
      from === 'user' ? 'is-user' : 'is-assistant',
      className,
    )}
    {...props}
  >
    {children}
  </div>
);

// ---------------------------------------------------------------------------
// MessageTimestamp – inline label for use inside MessageActions
// ---------------------------------------------------------------------------

function getTimeSincePrevious(
  previousTs: number,
  currentTs: number,
): string | null {
  const previousDate = new Date(previousTs);
  const currentDate = new Date(currentTs);

  if (
    !Number.isFinite(previousDate.getTime()) ||
    !Number.isFinite(currentDate.getTime())
  ) {
    return null;
  }

  const diffMs = currentTs - previousTs;
  if (diffMs <= 0) return null;

  const duration = intervalToDuration({
    start: previousDate,
    end: currentDate,
  });

  const formatted = formatDuration(duration, {
    format: ['years', 'months', 'weeks', 'days', 'hours', 'minutes', 'seconds'],
    delimiter: ', ',
  });

  return formatted ? `${formatted} afterwards` : null;
}

type MessageTimestampProps = {
  ts: number;
  previousTs?: number;
  anchorId?: string;
};

export function MessageTimestamp({
  ts,
  previousTs,
  anchorId,
}: MessageTimestampProps) {
  const date = new Date(ts);
  const isValidDate = Number.isFinite(date.getTime());

  if (!isValidDate) {
    return null;
  }

  const shortDate = isToday(date)
    ? format(date, 'h:mmaaa')
    : format(date, 'MMM d, h:mmaaa');
  const fullDate = format(date, 'MMM d, yyyy h:mmaaa');
  const durationText =
    previousTs !== undefined ? getTimeSincePrevious(previousTs, ts) : undefined;

  const tooltipLabel = durationText
    ? `${fullDate} · ${durationText}`
    : fullDate;

  const timestamp = (
    <time
      dateTime={date.toISOString()}
      className="text-xs text-muted-foreground whitespace-nowrap select-none"
    >
      {shortDate}
    </time>
  );

  return (
    <BasicTooltip content={<p>{tooltipLabel}</p>} side="top">
      {anchorId ? (
        <a
          href={`#${anchorId}`}
          className="hover:underline hover:text-foreground underline-offset-2"
        >
          {timestamp}
        </a>
      ) : (
        timestamp
      )}
    </BasicTooltip>
  );
}

type MessageContentProps = HTMLAttributes<HTMLDivElement>;

export const MessageContent = ({
  children,
  className,
  ...props
}: MessageContentProps) => (
  <div
    className={cn(
      // Shared styles
      'flex min-w-0 max-w-full flex-col gap-2 overflow-hidden',
      'text-sm',
      // Assistant messages
      'group-[.is-assistant]:w-full group-[.is-assistant]:text-foreground',
      className,
    )}
    {...props}
  >
    <div
      className={cn(
        // User messages
        'group-[.is-user]:w-auto group-[.is-user]:px-5 group-[.is-user]:py-3 group-[.is-user]:mb-1',
        'group-[.is-user]:rounded-lg group-[.is-user]:border-none',
        'group-[.is-user]:bg-foreground/10 group-[.is-user]:text-zinc-800',
        'dark:group-[.is-user]:bg-zinc-700 dark:group-[.is-user]:text-zinc-100',
      )}
    >
      {children}
    </div>
  </div>
);

type MessageActionsProps = ComponentProps<'div'>;

export const MessageActions = ({
  className,
  children,
  ...props
}: MessageActionsProps) => (
  <div
    className={cn(
      'flex items-center gap-1 pt-1',
      'opacity-100 md:opacity-0 transition-opacity duration-200 group-hover:opacity-100',
      className,
    )}
    {...props}
  >
    {children}
  </div>
);

type MessageActionProps = ButtonAsButtonProps & {
  tooltip?: string;
  label?: string;
};

export const MessageAction = ({
  tooltip,
  children,
  label,
  variant = 'ghost',
  size = 'icon',
  ...props
}: MessageActionProps) => {
  const button = (
    <Button size={size} type="button" variant={variant} {...props}>
      {children}
      <span className="sr-only">{label || tooltip}</span>
    </Button>
  );

  if (tooltip) {
    return <BasicTooltip content={tooltip}>{button}</BasicTooltip>;
  }

  return button;
};

type MessageCopyButtonProps = Omit<
  MessageActionProps,
  'tooltip' | 'children'
> & {
  content: string;
};

export const MessageCopyButton = ({
  content,
  ...props
}: MessageCopyButtonProps) => (
  <CopyIconButton content={content} tooltip="Copy" {...props} />
);

/**
 * Messages longer than this are not eligible for the "Use for new task" action
 * because percent-encoding inflates the content well beyond common URL length
 * limits, causing silent navigation failures.
 */
const MAX_NEW_TASK_CONTENT_LENGTH = 5_000;

type MessageNewTaskButtonProps = Omit<
  MessageActionProps,
  'tooltip' | 'children'
> & {
  content: string;
};

export const MessageNewTaskButton = ({
  content,
  ...props
}: MessageNewTaskButtonProps) => {
  const { hideNewTaskAction } = useMessageUiOptions();

  if (hideNewTaskAction) return null;
  if (content.length > MAX_NEW_TASK_CONTENT_LENGTH) return null;

  return (
    <MessageAction
      tooltip="Use for new task"
      onClick={() => {
        window.location.href = `/?prompt=${encodeURIComponent(content)}`;
      }}
      {...props}
    >
      <ArrowUpRightIcon className="size-4 text-muted-foreground" />
    </MessageAction>
  );
};

interface MessageBranchContextType {
  currentBranch: number;
  totalBranches: number;
  goToPrevious: () => void;
  goToNext: () => void;
  branches: ReactElement[];
  setBranches: (branches: ReactElement[]) => void;
}

const MessageBranchContext = createContext<MessageBranchContextType | null>(
  null,
);

const useMessageBranch = () => {
  const context = useContext(MessageBranchContext);

  if (!context) {
    throw new Error(
      'MessageBranch components must be used within MessageBranch',
    );
  }

  return context;
};

type MessageBranchProps = HTMLAttributes<HTMLDivElement> & {
  defaultBranch?: number;
  onBranchChange?: (branchIndex: number) => void;
};

export const MessageBranch = ({
  defaultBranch = 0,
  onBranchChange,
  className,
  ...props
}: MessageBranchProps) => {
  const [currentBranch, setCurrentBranch] = useState(defaultBranch);
  const [branches, setBranches] = useState<ReactElement[]>([]);

  const handleBranchChange = (newBranch: number) => {
    setCurrentBranch(newBranch);
    onBranchChange?.(newBranch);
  };

  const goToPrevious = () => {
    const newBranch =
      currentBranch > 0 ? currentBranch - 1 : branches.length - 1;
    handleBranchChange(newBranch);
  };

  const goToNext = () => {
    const newBranch =
      currentBranch < branches.length - 1 ? currentBranch + 1 : 0;
    handleBranchChange(newBranch);
  };

  const contextValue: MessageBranchContextType = {
    currentBranch,
    totalBranches: branches.length,
    goToPrevious,
    goToNext,
    branches,
    setBranches,
  };

  return (
    <MessageBranchContext.Provider value={contextValue}>
      <div
        className={cn('grid w-full gap-2 [&>div]:pb-0', className)}
        {...props}
      />
    </MessageBranchContext.Provider>
  );
};

type MessageBranchContentProps = HTMLAttributes<HTMLDivElement>;

export const MessageBranchContent = ({
  children,
  ...props
}: MessageBranchContentProps) => {
  const { currentBranch, setBranches, branches } = useMessageBranch();

  const childrenArray = useMemo(
    () => (Array.isArray(children) ? children : [children]),
    [children],
  );

  // Use useEffect to update branches when they change.
  useEffect(() => {
    if (branches.length !== childrenArray.length) {
      setBranches(childrenArray);
    }
  }, [childrenArray, branches, setBranches]);

  return childrenArray.map((branch, index) => (
    <div
      className={cn(
        'grid gap-2 overflow-hidden [&>div]:pb-0',
        index === currentBranch ? 'block' : 'hidden',
      )}
      key={branch.key}
      {...props}
    >
      {branch}
    </div>
  ));
};

type MessageBranchSelectorProps = HTMLAttributes<HTMLDivElement> & {
  from: UIMessage['role'];
};

export const MessageBranchSelector = ({
  className: _className,
  from: _from,
  ...props
}: MessageBranchSelectorProps) => {
  const { totalBranches } = useMessageBranch();

  // Don't render if there's only one branch
  if (totalBranches <= 1) {
    return null;
  }

  return (
    <ButtonGroup
      className="[&>*:not(:first-child)]:rounded-l-md [&>*:not(:last-child)]:rounded-r-md"
      orientation="horizontal"
      {...props}
    />
  );
};

type MessageBranchPreviousProps = ButtonAsButtonProps;

export const MessageBranchPrevious = ({
  children,
  ...props
}: MessageBranchPreviousProps) => {
  const { goToPrevious, totalBranches } = useMessageBranch();

  return (
    <Button
      aria-label="Previous branch"
      disabled={totalBranches <= 1}
      onClick={goToPrevious}
      size="icon"
      type="button"
      variant="ghost"
      {...props}
    >
      {children ?? <ChevronLeftIcon size={14} />}
    </Button>
  );
};

type MessageBranchNextProps = ButtonAsButtonProps;

export const MessageBranchNext = ({
  children,
  ...props
}: MessageBranchNextProps) => {
  const { goToNext, totalBranches } = useMessageBranch();

  return (
    <Button
      aria-label="Next branch"
      disabled={totalBranches <= 1}
      onClick={goToNext}
      size="icon"
      type="button"
      variant="ghost"
      {...props}
    >
      {children ?? <ChevronRightIcon size={14} />}
    </Button>
  );
};

type MessageBranchPageProps = HTMLAttributes<HTMLSpanElement>;

export const MessageBranchPage = ({
  className,
  ...props
}: MessageBranchPageProps) => {
  const { currentBranch, totalBranches } = useMessageBranch();

  return (
    <ButtonGroupText
      className={cn(
        'border-none bg-transparent text-muted-foreground shadow-none',
        className,
      )}
      {...props}
    >
      {currentBranch + 1} of {totalBranches}
    </ButtonGroupText>
  );
};

type MessageResponseProps = ComponentProps<typeof Streamdown>;

type MessagePlainTextProps = ComponentProps<'div'>;

export const CustomParagraph = ({
  className,
  children,
  node: _node,
  ...props
}: HTMLAttributes<HTMLParagraphElement> & {
  node?: {
    tagName?: string;
    position?: { start: { line: number }; end: { line: number } };
  };
}) => (
  <p
    className={cn('min-w-0 [overflow-wrap:anywhere]', className)}
    data-streamdown="paragraph"
    {...props}
  >
    {children}
  </p>
);

export const MessagePlainText = ({
  className,
  children,
  ...props
}: MessagePlainTextProps) => (
  <div
    className={cn(
      'size-full min-w-0 whitespace-pre-wrap break-words [overflow-wrap:anywhere] leading-relaxed',
      className,
    )}
    {...props}
  >
    {children}
  </div>
);

export const MessageResponse = memo(
  ({ className, ...props }: MessageResponseProps) => (
    <Streamdown
      className={cn(
        'size-full min-w-0 [overflow-wrap:anywhere] [&>*:first-child]:mt-0 [&>*:last-child]:mb-0 [&>*]:min-w-0 leading-relaxed',
        className,
      )}
      remarkPlugins={[
        ...Object.values(defaultRemarkPlugins),
        remarkBreaks,
        remarkAutolinkUrls,
        remarkArtifactLinks,
      ]}
      plugins={streamdownPlugins}
      components={{ a: CustomLink, p: CustomParagraph }}
      {...props}
    />
  ),
  (prevProps, nextProps) => prevProps.children === nextProps.children,
);

MessageResponse.displayName = 'MessageResponse';

type MessageToolbarProps = ComponentProps<'div'>;

export const MessageToolbar = ({
  className,
  children,
  ...props
}: MessageToolbarProps) => (
  <div
    className={cn(
      'mt-4 flex w-full items-center justify-between gap-4',
      className,
    )}
    {...props}
  >
    {children}
  </div>
);
