'use client';

import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/system';
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
      <DialogContent size="2xl" aria-describedby={undefined}>
        <DialogHeader>
          <DialogTitle>New Session</DialogTitle>
        </DialogHeader>
        <NewTaskForm onTaskStarted={() => onOpenChange(false)} />
      </DialogContent>
    </Dialog>
  );
}
