import { BasicTooltip, HatGlasses } from '@/components/system';
import { cn } from '@/lib/utils';

export function PrivateSessionIcon({ className }: { className?: string }) {
  return (
    <BasicTooltip content="Private session">
      <span
        aria-label="Private session"
        className={cn(
          'pointer-events-auto inline-flex shrink-0 items-center',
          className,
        )}
      >
        <HatGlasses className="size-3.5" aria-hidden="true" />
      </span>
    </BasicTooltip>
  );
}
