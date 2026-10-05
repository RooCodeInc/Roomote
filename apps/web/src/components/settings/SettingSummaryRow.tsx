import type { ReactNode } from 'react';

import { Button, type LucideIcon } from '@/components/system';

export function SettingSummaryRow({
  icon: Icon,
  label,
  value,
  onEdit,
  actionLabel = 'Edit',
  action,
}: {
  icon: LucideIcon;
  label: string;
  value: ReactNode;
  onEdit?: () => void;
  actionLabel?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex min-w-0 items-center gap-2 text-sm text-muted-foreground">
      <Icon className="size-4 shrink-0" />
      <div className="flex min-w-0 flex-wrap items-center gap-x-1">
        <span>{label}:</span>
        <span className="min-w-0 truncate font-medium text-foreground">
          {value}
        </span>
        {action ?? (
          <Button
            type="button"
            variant="link"
            size="sm"
            className="h-auto p-0"
            onClick={onEdit}
          >
            {actionLabel}
          </Button>
        )}
      </div>
    </div>
  );
}
