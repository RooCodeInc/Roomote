'use client';

import { Dialog, DialogContent, DialogTitle } from '@/components/system';
import { NewTaskForm } from './NewTaskForm';

export function NewTaskDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        size="2xl"
        aria-describedby={undefined}
        className="p-0"
        overlayClassName="bg-black/75"
      >
        <DialogTitle className="sr-only">New Session</DialogTitle>
        <NewTaskForm
          animate={false}
          allowEmptySession
          onTaskStarted={() => onOpenChange(false)}
        />
      </DialogContent>
    </Dialog>
  );
}
