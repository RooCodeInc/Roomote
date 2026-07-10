'use client';

import { memo, useState, type MouseEventHandler } from 'react';

import { SideNavItem } from '@/components/layout/side-nav/SideNavItem';
import { useRestoreTaskRunSnapshot } from '@/hooks/snapshots';
import {
  AppWindow,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/system';

import { useTaskSidePanel } from '../hooks/use-task-side-panel';
import { usePreviewPane } from '../hooks/use-preview-pane';
import {
  resolvePreviewTarget,
  usePreviewUrls,
} from '../hooks/use-preview-urls';
import { buildPreviewIframeUrl, isModifiedClick } from '../preview-iframe-url';

import type { SidebarActionBaseProps } from './types';

import { isTaskRunAsleep } from './utils';

function LivePreviewButtonBase({
  taskRun,
  disabled: disabledUntilReady = false,
}: SidebarActionBaseProps & { disabled?: boolean }) {
  const [showWakeDialog, setShowWakeDialog] = useState(false);
  const { initialPaths, previewUrl, previewUrls, primaryPortName } =
    usePreviewUrls(taskRun ?? {});
  const { isViewActive, openPreviewView, previewPath, previewServiceName } =
    useTaskSidePanel();
  const { openPreviewPane } = usePreviewPane();
  const restoreSnapshot = useRestoreTaskRunSnapshot({
    onSuccess: () => setShowWakeDialog(false),
  });
  const {
    previewServiceName: resolvedPreviewServiceName,
    previewUrl: resolvedPreviewUrl,
  } = resolvePreviewTarget({
    initialPaths,
    previewPath,
    previewServiceName,
    previewUrl,
    previewUrls,
    primaryPortName,
  });

  const asleep = isTaskRunAsleep(taskRun);
  const canWakeForPreview =
    asleep && !!taskRun?.snapshotId && !!resolvedPreviewUrl;
  const openUrl =
    resolvedPreviewUrl && taskRun
      ? buildPreviewIframeUrl(resolvedPreviewUrl, taskRun.id)
      : null;
  const disabled =
    disabledUntilReady ||
    !taskRun ||
    !resolvedPreviewUrl ||
    (asleep && !canWakeForPreview);
  const tooltip = disabledUntilReady
    ? undefined
    : canWakeForPreview
      ? 'Wake up Roomote to use Live Preview'
      : asleep
        ? 'Live Preview is only available when Roomote is awake'
        : !resolvedPreviewUrl
          ? 'Live Preview is not available'
          : 'Live Preview';

  const handleWakeConfirm = async () => {
    if (!taskRun?.snapshotId || restoreSnapshot.isPending) {
      return;
    }

    try {
      await restoreSnapshot.mutateAsync({
        sourceSnapshotId: taskRun.snapshotId,
        sourceRunId: taskRun.id,
        resumePrompt: '',
      });
    } catch {
      // The mutation hook already surfaces the error to the user.
    }
  };

  const handleClick: MouseEventHandler<HTMLAnchorElement> = (event) => {
    if (!taskRun || !resolvedPreviewUrl) {
      return;
    }

    if (isModifiedClick(event) || !openUrl) {
      return;
    }

    event.preventDefault();
    openPreviewPane(
      resolvedPreviewUrl,
      taskRun.id,
      resolvedPreviewServiceName ?? undefined,
    );
    openPreviewView(
      resolvedPreviewUrl,
      taskRun.id,
      resolvedPreviewServiceName ?? undefined,
    );
  };

  return (
    <>
      <SideNavItem
        side="right"
        label="Live Preview"
        tooltip={tooltip}
        description={
          canWakeForPreview
            ? 'Wake this task so live preview becomes available'
            : disabled
              ? undefined
              : "Preview this task's app"
        }
        active={!disabled && !canWakeForPreview && isViewActive('preview')}
        disabled={disabled}
        href={
          canWakeForPreview || disabled ? undefined : (openUrl ?? undefined)
        }
        useNativeLink={true}
        onClick={canWakeForPreview ? () => setShowWakeDialog(true) : undefined}
        icon={AppWindow}
        linkProps={
          disabled || canWakeForPreview
            ? undefined
            : {
                rel: 'noreferrer',
                target: '_blank',
                onClick: handleClick,
              }
        }
      />
      <Dialog open={showWakeDialog} onOpenChange={setShowWakeDialog}>
        <DialogContent size="sm">
          <DialogHeader>
            <DialogTitle>Wake up Roomote?</DialogTitle>
            <DialogDescription>
              Live Preview needs the task to be awake. Waking it up will restore
              the task and make preview available again.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setShowWakeDialog(false)}
              disabled={restoreSnapshot.isPending}
            >
              Cancel
            </Button>
            <Button
              type="button"
              onClick={() => void handleWakeConfirm()}
              disabled={restoreSnapshot.isPending}
            >
              {restoreSnapshot.isPending ? 'Waking up...' : 'Wake up'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

export const LivePreviewButton = memo(LivePreviewButtonBase);
