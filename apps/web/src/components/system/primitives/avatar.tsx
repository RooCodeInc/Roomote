'use client';

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

export function getInitials(name?: string | null, email?: string | null) {
  const trimmedName = name?.trim();
  if (trimmedName) {
    const fromName = trimmedName
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => {
        const first = [...part][0];
        return first ? first.toUpperCase() : '';
      })
      .join('');

    if (fromName) {
      return fromName;
    }
  }

  const trimmedEmail = email?.trim();
  if (trimmedEmail) {
    const first = [...trimmedEmail][0];
    return first ? first.toUpperCase() : '';
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
    const [imageFailed, setImageFailed] = React.useState(false);
    const initials = getInitials(name, email);
    const label = alt ?? (name?.trim() || email?.trim() || '');
    const showImage = resolvedImageUrl !== null && !imageFailed;

    React.useEffect(() => {
      setImageFailed(false);
    }, [resolvedImageUrl]);

    return (
      <div
        ref={ref}
        aria-label={label || undefined}
        aria-hidden={label ? undefined : true}
        className={cn(
          'flex shrink-0 items-center justify-center overflow-hidden rounded-full border border-border bg-muted text-muted-foreground font-medium uppercase',
          AVATAR_SIZES[size],
          className,
        )}
        {...props}
      >
        {showImage ? (
          // eslint-disable-next-line @next/next/no-img-element -- external avatar URLs come from arbitrary OAuth provider hosts
          <img
            src={resolvedImageUrl}
            alt=""
            className={cn('size-full object-cover', imgClassName)}
            loading="lazy"
            decoding="async"
            onError={() => setImageFailed(true)}
          />
        ) : (
          <span aria-hidden="true">{initials || '?'}</span>
        )}
      </div>
    );
  },
);
