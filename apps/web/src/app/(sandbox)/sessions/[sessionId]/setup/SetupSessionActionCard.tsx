'use client';

import type { ReactNode } from 'react';

import { ArrowLeft, Button } from '@/components/system';

/**
 * Conversation-native action surface for trusted setup controls.
 *
 * Its proportions deliberately match the product-tip assistant message: setup
 * should feel like part of the conversation, not a full-page wizard embedded
 * inside one.
 */
export function SetupSessionActionCard({
  title,
  icon,
  intro,
  children,
}: {
  title: string;
  icon: ReactNode;
  intro: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="w-full max-w-2xl rounded-xl bg-card p-5 text-sm sm:p-6">
      <div className="flex items-start gap-3">
        <span
          className="mt-0.5 shrink-0 text-muted-foreground [&>svg]:size-6"
          aria-hidden="true"
        >
          {icon}
        </span>
        <div className="min-w-0 flex-1 space-y-4">
          <div className="max-w-xl space-y-1">
            <h2 className="font-semibold">{title}</h2>
            <div className="text-muted-foreground">{intro}</div>
          </div>
          {children}
        </div>
      </div>
    </section>
  );
}

export function SetupSessionActionCardActions({
  children,
  onBack,
  backDisabled = false,
}: {
  children?: ReactNode;
  onBack?: () => void;
  backDisabled?: boolean;
}) {
  if (!onBack && !children) return null;

  return (
    <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
      {onBack ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={onBack}
          disabled={backDisabled}
        >
          <ArrowLeft />
          Back
        </Button>
      ) : (
        <span />
      )}
      <div className="flex flex-wrap items-center justify-end gap-2">
        {children}
      </div>
    </div>
  );
}
