'use client';

import { useEffect, useRef, useState } from 'react';

import { cn } from '@/lib/utils';

function Skeleton({ className, ...props }: React.ComponentProps<'div'>) {
  const ref = useRef<HTMLDivElement>(null);
  const [rect, setRect] = useState<{
    w: number;
    h: number;
    rx: number;
    ry: number;
  } | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const measure = () => {
      const { width, height } = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      // Parse the resolved border-radius (handles rounded-full → 9999px, etc.)
      const rx = Math.min(
        parseFloat(cs.borderTopLeftRadius) || 0,
        width / 2,
        height / 2,
      );
      const ry = rx;
      setRect({ w: width, h: height, rx, ry });
    };

    const ro = new ResizeObserver(measure);
    ro.observe(el);
    measure();

    return () => ro.disconnect();
  }, []);

  // Fixed dash sizes in pixels for consistent appearance across all skeleton sizes
  const dashLength = 2;
  const gapLength = 4;
  const cycleLength = dashLength + gapLength; // animate exactly one cycle for seamless loop

  return (
    <div
      ref={ref}
      data-slot="skeleton"
      className={cn('relative rounded-md', className)}
      {...props}
    >
      {rect && rect.w > 0 && rect.h > 0 && (
        <svg
          aria-hidden
          className="pointer-events-none absolute inset-0 size-full"
          viewBox={`0 0 ${rect.w} ${rect.h}`}
          fill="none"
          preserveAspectRatio="none"
        >
          <rect
            x={0.5}
            y={0.5}
            width={rect.w - 1}
            height={rect.h - 1}
            rx={Math.max(0, rect.rx - 0.5)}
            ry={Math.max(0, rect.ry - 0.5)}
            className="fill-foreground/5 stroke-foreground/40 dark:stroke-border/80 animate-[skeleton-dash_1.5s_linear_infinite]"
            strokeWidth={1}
            strokeDasharray={`${dashLength} ${gapLength}`}
            style={
              { '--skeleton-cycle': `${cycleLength}` } as React.CSSProperties
            }
          />
        </svg>
      )}
    </div>
  );
}

export { Skeleton };
