'use client';

import { cn } from '@/lib/utils';

type RoomoteWordmarkProps = {
  className?: string;
  'aria-label'?: string;
};

export function RoomoteWordmark({
  className,
  'aria-label': ariaLabel = 'Roomote',
}: RoomoteWordmarkProps) {
  return (
    <span
      role="img"
      aria-label={ariaLabel}
      className={cn(
        'block h-10 aspect-[1226/458] bg-current text-foreground',
        className,
      )}
      style={{
        maskImage: 'url(/logos/roomote-wordmark.svg)',
        maskRepeat: 'no-repeat',
        maskPosition: 'center',
        maskSize: 'contain',
        WebkitMaskImage: 'url(/logos/roomote-wordmark.svg)',
        WebkitMaskRepeat: 'no-repeat',
        WebkitMaskPosition: 'center',
        WebkitMaskSize: 'contain',
      }}
    />
  );
}
