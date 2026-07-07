import type { DialogProps } from '@radix-ui/react-dialog';

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/system';

import { CreateEnvVar } from './CreateEnvVar';

type CreateEnvVarDialogProps = Omit<DialogProps, 'children'> & {
  onCreated: () => void;
};

export function CreateEnvVarDialog({
  onCreated,
  ...props
}: CreateEnvVarDialogProps) {
  return (
    <Dialog {...props}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Create Environment Variable</DialogTitle>
          <DialogDescription>
            Environment variables are injected into the containers that run your
            Cloud Agent tasks.
          </DialogDescription>
        </DialogHeader>
        <CreateEnvVar onCreated={onCreated} />
      </DialogContent>
    </Dialog>
  );
}
