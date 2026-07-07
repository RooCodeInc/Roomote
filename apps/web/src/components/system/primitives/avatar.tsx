import * as React from 'react';

import { cn } from '@/lib/utils';

const AVATAR_SIZES = {
  sm: 'size-6 text-[10px]',
  md: 'size-8 text-xs',
  lg: 'size-10 text-sm',
} as const;

type AvatarSize = keyof typeof AVATAR_SIZES;

type AvatarProps = {
  imageUrl?: string | null;
  name?: string | null;
  email?: string | null;
  size?: AvatarSize;
  className?: string;
  imgClassName?: string;
  alt?: string;
} & Omit<React.ComponentProps<'div'>, 'className'>;

function getInitials(name?: string | null, email?: string | null) {
  const trimmedName = name?.trim();
  if (trimmedName) {
    const fromName = trimmedName
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0]?.toUpperCase())
      .join('');

    if (fromName) {
      return fromName;
    }
  }

  const trimmedEmail = email?.trim();
  if (trimmedEmail) {
    return trimmedEmail[0]?.toUpperCase() ?? '';
  }

  return '';
}

export const Avatar = React.forwardRef<HTMLDivElement, AvatarProps>(
  function Avatar(
    {
      imageUrl,
      name,
      email,
      size = 'md',
      className,
      imgClassName,
      alt,
      ...props
    },
    ref,
  ) {
    const resolvedImageUrl = imageUrl?.trim() ? imageUrl.trim() : null;
    const initials = getInitials(name, email);
    const label = alt ?? (name?.trim() || email?.trim() || '');

    return (
      <div
        ref={ref}
        className={cn(
          'flex shrink-0 items-center justify-center overflow-hidden rounded-full border border-border bg-muted text-muted-foreground font-medium uppercase',
          AVATAR_SIZES[size],
          className,
        )}
        aria-hidden={label ? undefined : true}
        {...props}
      >
        {resolvedImageUrl ? (
          // eslint-disable-next-line @next/next/no-img-element -- external avatar URLs come from arbitrary OAuth provider hosts
          <img
            src={resolvedImageUrl}
            alt={label}
            className={cn('size-full object-cover', imgClassName)}
            loading="lazy"
            decoding="async"
          />
        ) : (
          <span aria-hidden="true">{initials || '?'}</span>
        )}
      </div>
    );
  },
);
