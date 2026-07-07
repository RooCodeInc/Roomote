import {
  Empty,
  EmptyHeader,
  EmptyMedia,
  EmptyDescription,
  CircleX,
} from '@/components/system';

export function TaskCardError() {
  return (
    <Empty>
      <EmptyHeader>
        <EmptyMedia variant="icon" className="text-destructive">
          <CircleX />
        </EmptyMedia>
        <EmptyDescription className="text-sm">
          Failed to load tasks.
        </EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}
