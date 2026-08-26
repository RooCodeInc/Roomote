import { cn } from '@/lib/utils';

type WorkspaceHeaderProps = React.ComponentProps<'header'> & {
  contentClassName?: string;
};

export function WorkspaceHeader({
  children,
  className,
  contentClassName,
  ...props
}: WorkspaceHeaderProps) {
  return (
    <header
      className={cn(
        'flex shrink-0 items-center overflow-hidden border-b-2 border-card py-3 @container',
        className,
      )}
      {...props}
    >
      <div
        className={cn(
          'relative mx-auto flex min-w-0 max-w-4xl flex-1 flex-col gap-2 px-4 @[600px]:flex-row @[600px]:items-center @[600px]:gap-4',
          contentClassName,
        )}
      >
        {children}
      </div>
    </header>
  );
}
