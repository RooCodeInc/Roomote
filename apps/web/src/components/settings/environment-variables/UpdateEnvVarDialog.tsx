import type { DialogProps } from '@radix-ui/react-dialog';

import type { EnvironmentVariable } from '@roomote/db';

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/system';

import { UpdateEnvVar } from './UpdateEnvVar';

type UpdateEnvVarDialogProps = Omit<DialogProps, 'children'> & {
  envVar?: Omit<EnvironmentVariable, 'value'>;
  onUpdated: () => void;
};

export function UpdateEnvVarDialog({
  envVar,
  onUpdated,
  ...props
}: UpdateEnvVarDialogProps) {
  return (
    <Dialog {...props}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Edit Environment Variable</DialogTitle>
          <DialogDescription>
            Update the environment variable.
          </DialogDescription>
        </DialogHeader>
        {envVar && <UpdateEnvVar envVar={envVar} onUpdated={onUpdated} />}
      </DialogContent>
    </Dialog>
  );
}
