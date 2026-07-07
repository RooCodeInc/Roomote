import { LoaderCircle } from '@/components/system';

import { cn } from '@/lib/utils';

type LoadingProps = Omit<React.HTMLAttributes<HTMLDivElement>, 'children'> & {
  layout?:
    | 'authenticated'
    | 'centered'
    | 'landing'
    | 'public'
    | 'unauthenticated';
};

export const Loading = ({ className, layout, ...props }: LoadingProps) => (
  <div
    className={cn(
      'flex items-center justify-center',
      {
        'h-[calc(var(--effective-viewport-height)*0.75)]':
          layout === 'authenticated',
      },
      className,
    )}
    {...props}
  >
    <LoaderCircle className="animate-spin opacity-25" />
  </div>
);
