'use client';

import { AlertCircle } from 'lucide-react';

import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/system';
import {
  describeValidationError,
  isAttachmentTextLimitError,
} from '@/lib/validation-error';

const ATTACHMENT_LIMIT_GUIDANCE =
  'Try a different file, or provide a URL and Roomote will download it.';

export function ComposerErrorDialog(props: {
  /** The raw caught error, or null when the dialog is closed. */
  error: unknown;
  onClose: () => void;
}) {
  const isOpen = props.error !== null;
  const message = props.error
    ? describeValidationError(props.error, 'Something went wrong. Try again.')
    : '';
  const attachmentLimit = props.error
    ? isAttachmentTextLimitError(props.error)
    : false;

  return (
    <Dialog
      open={isOpen}
      onOpenChange={(open) => {
        if (!open) {
          props.onClose();
        }
      }}
    >
      {isOpen ? (
        <DialogContent size="md" showCloseButton={false}>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-destructive">
              <AlertCircle className="size-5 shrink-0" />
              {attachmentLimit ? 'Attachment too large' : 'Message not sent'}
            </DialogTitle>
            <DialogDescription className="text-foreground">
              <p className="whitespace-pre-line">{message}</p>
              {attachmentLimit ? (
                <p className="mt-2">{ATTACHMENT_LIMIT_GUIDANCE}</p>
              ) : null}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" onClick={props.onClose}>
              Got it
            </Button>
          </DialogFooter>
        </DialogContent>
      ) : null}
    </Dialog>
  );
}
