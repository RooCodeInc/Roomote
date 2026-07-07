'use client';

import { type ReactNode, useCallback, useRef, useState } from 'react';

import { cn } from '@/lib/utils';
import { copyToClipboard } from '@/lib/clipboard';

import { Button, type ButtonAsButtonProps } from './button';
import { CheckIcon, CopyIcon, type LucideIcon } from './icons';
import { BasicTooltip } from './tooltip';

type CopyIconButtonProps = Omit<ButtonAsButtonProps, 'children' | 'content'> & {
  content: string | (() => string);
  icon?: LucideIcon;
  tooltip?: ReactNode;
  iconClassName?: string;
  onCopied?: () => void;
};

export const CopyIconButton = ({
  content,
  icon: Icon = CopyIcon,
  tooltip,
  className,
  iconClassName,
  onCopied,
  onClick,
  variant = 'ghost',
  size = 'icon',
  ...props
}: CopyIconButtonProps) => {
  const [isCopied, setIsCopied] = useState(false);
  const timeoutRef = useRef<ReturnType<typeof setTimeout>>(null);

  const handleCopy = useCallback(
    async (e: React.MouseEvent<HTMLButtonElement>) => {
      onClick?.(e);

      if (isCopied) return;

      const value = typeof content === 'function' ? content() : content;
      const success = await copyToClipboard(value);

      if (success) {
        setIsCopied(true);
        onCopied?.();
        if (timeoutRef.current) clearTimeout(timeoutRef.current);
        timeoutRef.current = setTimeout(() => setIsCopied(false), 2000);
      }
    },
    [content, isCopied, onClick, onCopied],
  );

  const iconCn = iconClassName ?? 'size-3';

  const button = (
    <Button
      className={cn('relative', className)}
      onClick={handleCopy}
      size={size}
      type="button"
      variant={variant}
      {...props}
    >
      <span
        aria-hidden="true"
        className={cn(
          'pointer-events-none grid place-items-center overflow-hidden',
          iconCn,
        )}
      >
        <Icon
          className={cn(
            'col-start-1 row-start-1 transition-all',
            isCopied ? 'opacity-50 translate-y-5' : 'opacity-100 translate-y-0',
            iconCn,
          )}
        />
        <CheckIcon
          className={cn(
            'col-start-1 row-start-1 transition-all text-green-600',
            isCopied ? 'opacity-100 scale-110' : 'opacity-50 scale-0',
            iconCn,
          )}
        />
      </span>
      <span className="sr-only">
        {typeof tooltip === 'string' ? tooltip : 'Copy'}
      </span>
    </Button>
  );

  if (tooltip) {
    return <BasicTooltip content={tooltip}>{button}</BasicTooltip>;
  }

  return button;
};
