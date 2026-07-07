'use client';

import { Check, X } from '@/components/system';

const CIRCLE_RADIUS = 28;
const CIRCUMFERENCE = 2 * Math.PI * CIRCLE_RADIUS;

export function EmphaticResult({ success }: { success: boolean }) {
  const color = success ? 'text-green-600' : 'text-destructive';

  return (
    <div
      className={`relative flex items-center justify-center size-16 ${color}`}
    >
      {/* Animated circle */}
      <svg
        className="absolute inset-0 size-full -rotate-90"
        viewBox="0 0 64 64"
      >
        <circle
          cx="32"
          cy="32"
          r={CIRCLE_RADIUS}
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeDasharray={CIRCUMFERENCE}
          strokeDashoffset={CIRCUMFERENCE}
          className="animate-circle-draw"
        />
      </svg>

      {/* Icon */}
      <div className="animate-pop-in">
        {success ? (
          <Check className="size-8" strokeWidth={2} />
        ) : (
          <X className="size-8" strokeWidth={2} />
        )}
      </div>
    </div>
  );
}
