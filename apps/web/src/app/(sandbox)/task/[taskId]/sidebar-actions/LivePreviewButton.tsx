'use client';

import { memo, useState, type MouseEventHandler } from 'react';

import { SideNavItem } from '@/components/layout/side-nav/SideNavItem';
import { useRestoreCloudJobSnapshot } from '@/hooks/snapshots';
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

import { isCloudJobAsleep } from './utils';

function LivePreviewButtonBase({
  cloudJob,
  disabled: disabledUntilReady = false,
}: SidebarActionBaseProps & { disabled?: boolean }) {
  const [showWakeDialog, setShowWakeDialog] = useState(false);
  const { initialPaths, previewUrl, previewUrls, primaryPortName } =
    usePreviewUrls(cloudJob ?? {});
  const { isViewActive, openPreviewView, previewPath, previewServiceName } =
    useTaskSidePanel();
  const { openPreviewPane } = usePreviewPane();
  const restoreSnapshot = useRestoreCloudJobSnapshot({
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

  const asleep = isCloudJobAsleep(cloudJob);
  const canWakeForPreview =
    asleep && !!cloudJob?.snapshotId && !!resolvedPreviewUrl;
  const openUrl =
    resolvedPreviewUrl && cloudJob
      ? buildPreviewIframeUrl(resolvedPreviewUrl, cloudJob.id)
      : null;
  const disabled =
    disabledUntilReady ||
    !cloudJob ||
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
    if (!cloudJob?.snapshotId || restoreSnapshot.isPending) {
      return;
    }

    try {
      await restoreSnapshot.mutateAsync({
        sourceSnapshotId: cloudJob.snapshotId,
        sourceCloudJobId: cloudJob.id,
        resumePrompt: '',
      });
    } catch {
      // The mutation hook already surfaces the error to the user.
    }
  };

  const handleClick: MouseEventHandler<HTMLAnchorElement> = (event) => {
    if (!cloudJob || !resolvedPreviewUrl) {
      return;
    }

    if (isModifiedClick(event) || !openUrl) {
      return;
    }

    event.preventDefault();
    openPreviewPane(
      resolvedPreviewUrl,
      cloudJob.id,
      resolvedPreviewServiceName ?? undefined,
    );
    openPreviewView(
      resolvedPreviewUrl,
      cloudJob.id,
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
