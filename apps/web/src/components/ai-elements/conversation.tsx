'use client';

import type { ComponentProps } from 'react';
import { useCallback } from 'react';
import { StickToBottom, useStickToBottomContext } from 'use-stick-to-bottom';
import { ArrowDownIcon } from '@/components/system';
import type { ButtonAsButtonProps } from '@/components/system/primitives/button';

import { cn } from '@/lib/utils';

import { Button } from '@/components/system';

type ConversationProps = ComponentProps<typeof StickToBottom>;

export const Conversation = ({ className, ...props }: ConversationProps) => (
  <StickToBottom
    className={cn('relative flex-1 overflow-hidden', className)}
    initial="smooth"
    resize="smooth"
    role="log"
    {...props}
  />
);

type ConversationContentProps = ComponentProps<typeof StickToBottom.Content>;

export const ConversationContent = ({
  className,
  ...props
}: ConversationContentProps) => (
  <StickToBottom.Content
    className={cn('flex flex-col gap-2 min-w-0', className)}
    scrollClassName="scroll-thin"
    {...props}
  />
);

type ConversationScrollButtonProps = ButtonAsButtonProps;

export const ConversationScrollButton = ({
  className,
  ...props
}: ConversationScrollButtonProps) => {
  const { isAtBottom, scrollToBottom } = useStickToBottomContext();

  const handleScrollToBottom = useCallback(() => {
    scrollToBottom();
  }, [scrollToBottom]);

  return (
    <div
      className={cn(
        'pointer-events-none absolute bottom-0 left-0 right-0 z-50',
        'flex justify-center',
      )}
    >
      <div className="relative w-full 2xl:max-w-4xl">
        <Button
          className={cn(
            'pointer-events-auto cursor-pointer absolute right-6 rounded-full bg-card',
            'transition-all',
            isAtBottom ? '-bottom-8' : 'bottom-4',
            className,
          )}
          onClick={handleScrollToBottom}
          size="icon"
          type="button"
          variant="outline"
          {...props}
        >
          <ArrowDownIcon className="size-4" />
        </Button>
      </div>
    </div>
  );
};
