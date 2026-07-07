'use client';

import { useState } from 'react';

import { formatTokens } from '@/lib';
import { useIsMobile } from '@/hooks/useIsMobile';

import {
  Context,
  ContextContent,
  ContextContentBody,
  ContextContentHeader,
  ContextTrigger,
} from '@/components/ai-elements';

import { useSandboxAcpUsage } from '../hooks/SandboxProvider';

export function ContextUsage() {
  const acpUsage = useSandboxAcpUsage();
  const isMobile = useIsMobile();
  const [open, setOpen] = useState(false);

  if (!acpUsage || acpUsage.maxTokens <= 0) {
    return null;
  }

  return (
    <Context
      usedTokens={acpUsage.usedTokens}
      maxTokens={acpUsage.maxTokens}
      open={open}
      onOpenChange={setOpen}
    >
      <ContextTrigger
        variant="ghost"
        size="xs"
        className="h-6 rounded-full px-2 text-muted-foreground"
        aria-label="Context window usage"
        onTouchStart={
          isMobile
            ? () => {
                setOpen((current) => !current);
              }
            : undefined
        }
      />
      <ContextContent align="start">
        <ContextContentHeader />
        <ContextContentBody className="space-y-1.5">
          <div className="flex items-center justify-between text-xs">
            <span className="text-muted-foreground">Used</span>
            <span className="font-mono">
              {formatTokens(acpUsage.usedTokens)}
            </span>
          </div>
          <div className="flex items-center justify-between text-xs">
            <span className="text-muted-foreground">Window</span>
            <span className="font-mono">
              {formatTokens(acpUsage.maxTokens)}
            </span>
          </div>
          <div className="flex items-center justify-between text-xs">
            <span className="text-muted-foreground">Remaining</span>
            <span className="font-mono">
              {formatTokens(
                Math.max(acpUsage.maxTokens - acpUsage.usedTokens, 0),
              )}
            </span>
          </div>
        </ContextContentBody>
      </ContextContent>
    </Context>
  );
}
