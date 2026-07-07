import { useDeleteEnvironment } from '@/hooks/environments';

import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/system';

interface DeleteEnvironmentDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  environment: { id: string; name: string } | null;
  onDeleted: () => void;
}

export const DeleteEnvironmentDialog = ({
  open,
  onOpenChange,
  environment,
  onDeleted,
}: DeleteEnvironmentDialogProps) => {
  const deleteEnvironment = useDeleteEnvironment();

  const handleConfirm = async () => {
    if (!environment) {
      return;
    }

    await deleteEnvironment.mutateAsync({ id: environment.id });
    onDeleted();
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Delete Environment</DialogTitle>
          <DialogDescription>
            Are you sure you want to delete the environment{' '}
            <span className="font-semibold">{environment?.name}</span>? This
            action cannot be undone.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button
            type="button"
            variant="destructive"
            onClick={handleConfirm}
            disabled={deleteEnvironment.isPending}
          >
            {deleteEnvironment.isPending ? 'Deleting...' : 'Delete'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
