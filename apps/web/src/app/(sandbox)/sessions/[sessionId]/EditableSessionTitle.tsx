'use client';

import { useEffect, useState, type KeyboardEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';

import {
  Button,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
} from '@/components/system';
import { useTRPC } from '@/trpc/client';

type EditableSessionTitleProps = {
  sessionId: string;
  title: string;
  canRename: boolean;
  className: string;
  onTitleChange?: (title: string) => void;
};

export function EditableSessionTitle({
  sessionId,
  title,
  canRename,
  className,
  onTitleChange,
}: EditableSessionTitleProps) {
  if (!canRename) {
    return (
      <h1 title={title} className={className}>
        {title}
      </h1>
    );
  }

  return (
    <EditableSessionTitleControl
      sessionId={sessionId}
      title={title}
      className={className}
      onTitleChange={onTitleChange}
    />
  );
}

function EditableSessionTitleControl({
  sessionId,
  title,
  className,
  onTitleChange,
}: Omit<EditableSessionTitleProps, 'canRename'>) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const renameSession = useMutation(trpc.sessions.rename.mutationOptions());
  const [displayTitle, setDisplayTitle] = useState(title);
  const [titleDraft, setTitleDraft] = useState(title);
  const [isRenameDialogOpen, setIsRenameDialogOpen] = useState(false);

  useEffect(() => {
    setDisplayTitle(title);
  }, [title]);

  useEffect(() => {
    if (!isRenameDialogOpen) {
      setTitleDraft(displayTitle);
    }
  }, [displayTitle, isRenameDialogOpen]);

  const handleOpenRenameDialog = () => {
    setTitleDraft(displayTitle);
    setIsRenameDialogOpen(true);
  };

  const handleTitleKeyDown = (event: KeyboardEvent<HTMLHeadingElement>) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      handleOpenRenameDialog();
    }
  };

  const handleSaveTitle = async () => {
    const nextTitle = titleDraft.trim();
    const currentTitle = displayTitle.trim();

    if (!nextTitle) return;

    setIsRenameDialogOpen(false);
    if (nextTitle === currentTitle) return;

    setDisplayTitle(nextTitle);
    onTitleChange?.(nextTitle);

    try {
      await renameSession.mutateAsync({ sessionId, title: nextTitle });
    } catch (error) {
      setDisplayTitle(currentTitle);
      onTitleChange?.(currentTitle);
      toast.error(
        error instanceof Error ? error.message : 'Failed to rename session.',
      );
    } finally {
      void queryClient.invalidateQueries({
        queryKey: trpc.sessions.byId.queryKey({ sessionId }),
      });
      void queryClient.invalidateQueries({
        queryKey: trpc.sessions.list.queryKey(),
      });
      void queryClient.invalidateQueries({
        queryKey: trpc.sessions.search.queryKey(),
      });
    }
  };

  return (
    <>
      <h1
        role="button"
        tabIndex={0}
        onClick={handleOpenRenameDialog}
        onKeyDown={handleTitleKeyDown}
        aria-label="Edit session title"
        title={displayTitle}
        className={`${className} cursor-pointer rounded-sm hover:bg-muted/40 focus-visible:bg-muted/40 focus-visible:outline-1 focus-visible:outline-border`}
      >
        {displayTitle}
      </h1>
      <Dialog open={isRenameDialogOpen} onOpenChange={setIsRenameDialogOpen}>
        <DialogContent size="sm">
          <DialogHeader>
            <DialogTitle>Edit session title</DialogTitle>
          </DialogHeader>
          <form
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              void handleSaveTitle();
            }}
          >
            <Input
              type="text"
              value={titleDraft}
              onChange={(event) => setTitleDraft(event.target.value)}
              autoFocus
              onFocus={(event) => event.currentTarget.select()}
              maxLength={500}
            />
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => setIsRenameDialogOpen(false)}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={!titleDraft.trim()}>
                Save
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
