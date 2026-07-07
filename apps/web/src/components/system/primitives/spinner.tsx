import { cn } from '@/lib/utils';

const spinnerSizes = {
  sm: 'size-3 border-[1.5px]',
  default: 'size-4 border-2',
  lg: 'size-6 border-2',
} as const;

interface SpinnerProps {
  size?: keyof typeof spinnerSizes;
  className?: string;
}

export const Spinner = ({ size = 'default', className }: SpinnerProps) => (
  <div
    className={cn(
      'rounded-full border-muted-foreground/30 border-t-muted-foreground animate-spin',
      spinnerSizes[size],
      className,
    )}
  />
);
