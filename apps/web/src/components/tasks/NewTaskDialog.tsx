'use client';

import {
  Dialog,
  DialogContent,
  DialogDescription,
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
      <DialogContent size="2xl">
        <DialogHeader>
          <DialogTitle>New Session</DialogTitle>
          <DialogDescription>
            Choose where Roomote should work, then describe what you need.
          </DialogDescription>
        </DialogHeader>
        <NewTaskForm onTaskStarted={() => onOpenChange(false)} />
      </DialogContent>
    </Dialog>
  );
}
