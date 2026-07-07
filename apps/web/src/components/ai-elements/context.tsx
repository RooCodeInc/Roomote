'use client';

import type { LanguageModelUsage } from 'ai';
import { createContext, useContext, useMemo, type ComponentProps } from 'react';

import {
  Button,
  type ButtonAsButtonProps,
} from '@/components/system/primitives/button';
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from '@/components/system/primitives/hover-card';
import { Progress } from '@/components/system/primitives/progress';
import { cn } from '@/lib/utils';

const PERCENT_MAX = 100;
const ICON_RADIUS = 10;
const ICON_VIEWBOX = 24;
const ICON_CENTER = 12;
const ICON_STROKE_WIDTH = 2;

type ModelId = string;

interface ContextSchema {
  usedTokens: number;
  maxTokens: number;
  usage?: LanguageModelUsage;
  modelId?: ModelId;
}

const ContextValueContext = createContext<ContextSchema | null>(null);

const useContextValue = () => {
  const context = useContext(ContextValueContext);

  if (!context) {
    throw new Error('Context components must be used within Context');
  }

  return context;
};

function getUsagePercent(usedTokens: number, maxTokens: number): number {
  const safeMaxTokens = Math.max(maxTokens, 1);
  return Math.max(0, Math.min(1, usedTokens / safeMaxTokens));
}

type ContextProps = ComponentProps<typeof HoverCard> & ContextSchema;

export const Context = ({
  usedTokens,
  maxTokens,
  usage,
  modelId,
  ...props
}: ContextProps) => {
  const contextValue = useMemo(
    () => ({ maxTokens, modelId, usage, usedTokens }),
    [maxTokens, modelId, usage, usedTokens],
  );

  return (
    <ContextValueContext.Provider value={contextValue}>
      <HoverCard closeDelay={0} openDelay={0} {...props} />
    </ContextValueContext.Provider>
  );
};

const ContextIcon = () => {
  const { usedTokens, maxTokens } = useContextValue();
  const circumference = 2 * Math.PI * ICON_RADIUS;
  const usedPercent = getUsagePercent(usedTokens, maxTokens);
  const dashOffset = circumference * (1 - usedPercent);

  return (
    <svg
      aria-label="Model context usage"
      height="20"
      role="img"
      style={{ color: 'currentcolor' }}
      viewBox={`0 0 ${ICON_VIEWBOX} ${ICON_VIEWBOX}`}
      width="20"
    >
      <circle
        cx={ICON_CENTER}
        cy={ICON_CENTER}
        fill="none"
        opacity="0.25"
        r={ICON_RADIUS}
        stroke="currentColor"
        strokeWidth={ICON_STROKE_WIDTH}
      />
      <circle
        cx={ICON_CENTER}
        cy={ICON_CENTER}
        fill="none"
        opacity="0.7"
        r={ICON_RADIUS}
        stroke="currentColor"
        strokeDasharray={`${circumference} ${circumference}`}
        strokeDashoffset={dashOffset}
        strokeLinecap="round"
        strokeWidth={ICON_STROKE_WIDTH}
        style={{ transform: 'rotate(-90deg)', transformOrigin: 'center' }}
      />
    </svg>
  );
};

type ContextTriggerProps = ButtonAsButtonProps;

export const ContextTrigger = ({ children, ...props }: ContextTriggerProps) => {
  return (
    <HoverCardTrigger asChild>
      {children ?? (
        <Button type="button" variant="ghost" {...props}>
          <ContextIcon />
        </Button>
      )}
    </HoverCardTrigger>
  );
};

type ContextContentProps = ComponentProps<typeof HoverCardContent>;

export const ContextContent = ({
  className,
  ...props
}: ContextContentProps) => (
  <HoverCardContent
    className={cn('min-w-60 divide-y overflow-hidden p-0', className)}
    {...props}
  />
);

type ContextContentHeaderProps = ComponentProps<'div'>;

export const ContextContentHeader = ({
  children,
  className,
  ...props
}: ContextContentHeaderProps) => {
  const { usedTokens, maxTokens } = useContextValue();
  const usedPercent = getUsagePercent(usedTokens, maxTokens);
  const displayPct = new Intl.NumberFormat('en-US', {
    maximumFractionDigits: 1,
    style: 'percent',
  }).format(usedPercent);
  const used = new Intl.NumberFormat('en-US', {
    notation: 'compact',
  }).format(usedTokens);
  const total = new Intl.NumberFormat('en-US', {
    notation: 'compact',
  }).format(maxTokens);

  return (
    <div className={cn('w-full space-y-2 p-3', className)} {...props}>
      {children ?? (
        <>
          <div className="flex items-center justify-between gap-3 text-xs">
            <p>{displayPct}</p>
            <p className="font-mono text-muted-foreground">
              {used} / {total}
            </p>
          </div>
          <div className="space-y-2">
            <Progress className="bg-muted" value={usedPercent * PERCENT_MAX} />
          </div>
        </>
      )}
    </div>
  );
};

type ContextContentBodyProps = ComponentProps<'div'>;

export const ContextContentBody = ({
  children,
  className,
  ...props
}: ContextContentBodyProps) => (
  <div className={cn('w-full p-3', className)} {...props}>
    {children}
  </div>
);
