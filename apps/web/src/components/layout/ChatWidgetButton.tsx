'use client';

import { useEffect, useState } from 'react';
import { usePathname } from 'next/navigation';

import {
  Button,
  MessageCircleQuestionMark,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/system';
import { cn } from '@/lib/utils';

import { SideNavItem } from './side-nav/SideNavItem';

function shouldShowDefaultChatWidgetLauncher(pathname: string | null): boolean {
  if (!pathname) return false;

  return (
    pathname.startsWith('/setup') ||
    pathname.startsWith('/onboarding') ||
    pathname.startsWith('/settings') ||
    pathname.startsWith('/analytics') ||
    pathname.startsWith('/automations')
  );
}

function useChatWidgetButton() {
  const pathname = usePathname();
  const [hasIntercom, setHasIntercom] = useState(false);

  useEffect(() => {
    if (window.Intercom) {
      setHasIntercom(true);
      return;
    }

    const intervalId = window.setInterval(() => {
      if (!window.Intercom) return;
      setHasIntercom(true);
      window.clearInterval(intervalId);
    }, 250);

    return () => window.clearInterval(intervalId);
  }, []);

  return {
    isVisible: hasIntercom && !shouldShowDefaultChatWidgetLauncher(pathname),
    show: () => window.Intercom?.('show'),
  };
}

export function ChatWidgetButton({
  expanded = false,
  className,
}: {
  expanded?: boolean;
  className?: string;
}) {
  const chatWidgetButton = useChatWidgetButton();

  if (!chatWidgetButton.isVisible) {
    return null;
  }

  const button = (
    <Button
      type="button"
      variant="ghost"
      size={expanded ? 'default' : 'icon'}
      aria-label="Contact support"
      className={cn(
        'text-foreground hover:text-accent-foreground hover:bg-transparent',
        expanded
          ? 'w-full justify-start rounded-xl px-2.5'
          : 'size-9 rounded-full',
        className,
      )}
      onClick={chatWidgetButton.show}
    >
      <MessageCircleQuestionMark className="size-5 shrink-0" />
      {expanded ? (
        <span className="min-w-0 overflow-hidden pl-2">
          <span className="block w-full truncate text-left font-medium">
            Help
          </span>
        </span>
      ) : null}
    </Button>
  );

  if (expanded) {
    return button;
  }

  return (
    <Tooltip delayDuration={400}>
      <TooltipTrigger asChild>{button}</TooltipTrigger>
      <TooltipContent side="right" align="center">
        Contact support
      </TooltipContent>
    </Tooltip>
  );
}

export function ChatWidgetSideNavItem({
  expanded = false,
}: {
  expanded?: boolean;
}) {
  const chatWidgetButton = useChatWidgetButton();

  if (!chatWidgetButton.isVisible) {
    return null;
  }

  return (
    <SideNavItem
      icon={MessageCircleQuestionMark}
      label="Help"
      tooltip="Contact support"
      description="We're always happy to help"
      expanded={expanded}
      active={false}
      onClick={chatWidgetButton.show}
      className="relative -left-0.5"
    />
  );
}
