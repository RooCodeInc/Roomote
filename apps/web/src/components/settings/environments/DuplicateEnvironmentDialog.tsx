'use client';

import { useState, useEffect } from 'react';

import type { EnvironmentWithMeta } from '@/trpc/commands/environments';

import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
} from '@/components/system';

interface DuplicateEnvironmentDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  environment: EnvironmentWithMeta | undefined;
  onDuplicate: (env: EnvironmentWithMeta, newName: string) => void;
  isPending: boolean;
}

export function DuplicateEnvironmentDialog({
  open,
  onOpenChange,
  environment,
  onDuplicate,
  isPending,
}: DuplicateEnvironmentDialogProps) {
  const [newName, setNewName] = useState('');
  const [error, setError] = useState('');

  // Reset when environment changes.
  useEffect(() => {
    if (environment) {
      setNewName(`${environment.name} (Copy)`);
      setError('');
    }
  }, [environment]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();

    if (!environment) {
      return;
    }

    if (!newName.trim()) {
      setError('Name is required');
      return;
    }

    if (newName.trim() === environment.name) {
      setError('Please choose a different name');
      return;
    }

    setError('');
    onDuplicate(environment, newName.trim());
  };

  const handleOpenChange = (newOpen: boolean) => {
    if (!newOpen) {
      setNewName('');
      setError('');
    }

    onOpenChange(newOpen);
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Duplicate Environment</DialogTitle>
          <DialogDescription>
            Create a copy of &quot;{environment?.name}&quot; with a new name.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="new-name">New Environment Name</Label>
            <Input
              id="new-name"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="Enter a name for the copy"
              data-1p-ignore
            />
            {error && <p className="text-sm text-destructive">{error}</p>}
          </div>

          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => handleOpenChange(false)}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={isPending}>
              {isPending ? 'Duplicating...' : 'Duplicate'}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
