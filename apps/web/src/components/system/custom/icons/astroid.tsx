import { forwardRef } from 'react';
import type { LucideProps } from 'lucide-react';

/**
 * Lucide Astroid path inlined because the repo pins lucide-react@^0.575.0,
 * which predates the official Astroid export. Swap to the lucide-react export
 * once that dependency is bumped past the version that ships Astroid.
 * Source: https://lucide.dev/icons/astroid
 */
export const Astroid = forwardRef<SVGSVGElement, LucideProps>(
  (
    {
      color = 'currentColor',
      size = 24,
      strokeWidth = 2,
      absoluteStrokeWidth,
      className,
      ...props
    },
    ref,
  ) => (
    <svg
      ref={ref}
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke={color}
      strokeWidth={
        absoluteStrokeWidth
          ? (Number(strokeWidth) * 24) / Number(size)
          : strokeWidth
      }
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      {...props}
    >
      <path d="M12.983 21.186a1 1 0 0 1-1.966 0 10 10 0 0 0-8.203-8.203 1 1 0 0 1 0-1.966 10 10 0 0 0 8.203-8.203 1 1 0 0 1 1.966 0 10 10 0 0 0 8.203 8.203 1 1 0 0 1 0 1.966 10 10 0 0 0-8.203 8.203" />
    </svg>
  ),
);

Astroid.displayName = 'Astroid';
