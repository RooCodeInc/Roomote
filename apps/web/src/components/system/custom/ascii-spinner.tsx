'use client';

import { useEffect, useState } from 'react';

import { cn } from '@/lib/utils';

const SPINNER_FRAMES = ['⣯', '⣟', '⡿', '⢿', '⣻', '⣽', '⣾', '⣷'] as const;

interface ASCIISpinnerProps {
  className?: string;
  interval?: number;
}

export function ASCIISpinner({ className, interval = 100 }: ASCIISpinnerProps) {
  const [frame, setFrame] = useState(0);

  useEffect(() => {
    const id = setInterval(
      () => setFrame((prev) => (prev + 1) % SPINNER_FRAMES.length),
      interval,
    );
    return () => clearInterval(id);
  }, [interval]);

  return (
    <span className={cn('inline-block text-zinc-400', className)}>
      {SPINNER_FRAMES[frame]}
    </span>
  );
}
