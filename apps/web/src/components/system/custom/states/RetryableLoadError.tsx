import { CircleX } from 'lucide-react';

import { Button } from '../../primitives/button';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
} from '../../primitives/empty';

export function RetryableLoadError({
  message,
  isRetrying = false,
  onRetry,
  className,
}: {
  message: string;
  isRetrying?: boolean;
  onRetry: () => void;
  className?: string;
}) {
  return (
    <Empty className={className}>
      <EmptyHeader>
        <EmptyMedia variant="icon" className="text-destructive">
          <CircleX />
        </EmptyMedia>
        <EmptyDescription className="text-sm">{message}</EmptyDescription>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={isRetrying}
          onClick={onRetry}
        >
          Retry
        </Button>
      </EmptyHeader>
    </Empty>
  );
}
