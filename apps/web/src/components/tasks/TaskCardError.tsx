import {
  Empty,
  EmptyHeader,
  EmptyMedia,
  EmptyDescription,
  CircleX,
  Button,
} from '@/components/system';

export function TaskCardError({ onRetry }: { onRetry: () => void }) {
  return (
    <Empty>
      <EmptyHeader>
        <EmptyMedia variant="icon" className="text-destructive">
          <CircleX />
        </EmptyMedia>
        <EmptyDescription className="text-sm">
          Failed to load tasks.
        </EmptyDescription>
        <Button type="button" variant="outline" size="sm" onClick={onRetry}>
          Retry
        </Button>
      </EmptyHeader>
    </Empty>
  );
}
