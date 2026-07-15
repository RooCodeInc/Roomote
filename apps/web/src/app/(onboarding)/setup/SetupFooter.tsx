'use client';

import type { ReactNode } from 'react';

import { ArrowLeft, Button } from '@/components/system';
import { cn } from '@/lib/utils';

export function SetupFooter({
  onBack,
  children,
  className,
  backDisabled = false,
}: {
  onBack?: () => void;
  children?: ReactNode;
  className?: string;
  backDisabled?: boolean;
}) {
  return (
    <div className={cn('flex items-center gap-2', className)}>
      {onBack ? (
        <Button
          type="button"
          variant="outline"
          onClick={onBack}
          disabled={backDisabled}
        >
          <ArrowLeft />
          Back
        </Button>
      ) : null}
      {children}
    </div>
  );
}
