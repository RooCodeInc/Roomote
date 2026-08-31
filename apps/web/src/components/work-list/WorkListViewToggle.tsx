'use client';

import { Button, Columns3, List } from '@/components/system';

export type WorkListView = 'list' | 'board';

export function WorkListViewToggle({
  view,
  onChange,
}: {
  view: WorkListView;
  onChange: (view: WorkListView) => void;
}) {
  const isBoardView = view === 'board';

  return (
    <div className="flex items-center rounded-lg border border-border p-0.5">
      <Button
        variant={isBoardView ? 'ghost' : 'default'}
        size="sm"
        onClick={() => onChange('list')}
        aria-pressed={!isBoardView}
        aria-label="List view"
        title="List view"
        className="rounded-r-none"
      >
        <List />
      </Button>
      <Button
        variant={isBoardView ? 'default' : 'ghost'}
        size="sm"
        onClick={() => onChange('board')}
        aria-pressed={isBoardView}
        aria-label="Board view"
        title="Board view"
        className="rounded-l-none"
      >
        <Columns3 />
      </Button>
    </div>
  );
}
