import { getSessionStatusLabel, type SessionStatus } from '@roomote/types';

import { Badge } from '@/components/system';

const STATUS_VARIANTS: Record<
  SessionStatus,
  'success' | 'warning' | 'destructive' | 'secondary'
> = {
  active: 'success',
  needs_input: 'warning',
  blocked: 'destructive',
  ready: 'secondary',
};

function getSessionStatusVariant(status: string) {
  return STATUS_VARIANTS[status as SessionStatus] ?? 'secondary';
}

export function SessionStatusBadge({
  status,
  className,
}: {
  status: string;
  className?: string;
}) {
  return (
    <Badge variant={getSessionStatusVariant(status)} className={className}>
      {getSessionStatusLabel(status)}
    </Badge>
  );
}
