'use client';

import { memo, useState, type MouseEventHandler } from 'react';

import { DEFAULT_MANAGED_DEPLOYMENT_ACCESS } from '@roomote/types';

import { SideNavItem } from '@/components/layout/side-nav/SideNavItem';
import { useRestoreTaskRunSnapshot } from '@/hooks/snapshots';
import { useAuthorizedUser } from '@/hooks/useUser';
import { getTaskLaunchDisabledReason } from '@/lib/managed-access';
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
  const { managedAccess = DEFAULT_MANAGED_DEPLOYMENT_ACCESS } =
    useAuthorizedUser();
  const { initialPaths, previewUrl, previewUrls, primaryPortName } =
    usePreviewUrls(taskRun ?? {});
  const {
    isViewActive,
    openPreviewSetupView,
    openPreviewView,
    previewPath,
    previewServiceName,
  } = useTaskSidePanel();
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

  // Repo-only tasks have no environment to preview, so the button is hidden
  // entirely rather than opening a pane with nothing actionable in it.
  if (!taskRun?.payload?.environmentId) {
    return null;
  }

  const asleep = isTaskRunAsleep(taskRun);
  const canWakeForPreview =
    asleep && !!taskRun?.snapshotId && !!resolvedPreviewUrl;
  const taskLaunchDisabledReason = getTaskLaunchDisabledReason(managedAccess);
  const wakeDisabled = canWakeForPreview && Boolean(taskLaunchDisabledReason);
  const openUrl =
    resolvedPreviewUrl && taskRun
      ? buildPreviewIframeUrl(resolvedPreviewUrl, taskRun.id)
      : null;
  const hasPreviewUrl = Boolean(resolvedPreviewUrl);
  const disabled = disabledUntilReady || !taskRun || wakeDisabled;
  const tooltip = disabledUntilReady
    ? undefined
    : wakeDisabled
      ? taskLaunchDisabledReason
      : canWakeForPreview
        ? 'Wake up Roomote to use Live Preview'
        : !hasPreviewUrl
          ? 'Set up Live Preview'
          : 'Live Preview';

  const handleWakeConfirm = async () => {
    if (
      !taskRun?.snapshotId ||
      restoreSnapshot.isPending ||
      taskLaunchDisabledReason
    ) {
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
          wakeDisabled
            ? taskLaunchDisabledReason
            : canWakeForPreview
              ? 'Wake this task so live preview becomes available'
              : disabled
                ? undefined
                : hasPreviewUrl
                  ? "Preview this task's app"
                  : 'Set up live previews for this task'
        }
        active={!disabled && !canWakeForPreview && isViewActive('preview')}
        disabled={disabled}
        href={
          canWakeForPreview || disabled || !hasPreviewUrl
            ? undefined
            : (openUrl ?? undefined)
        }
        useNativeLink={true}
        onClick={
          canWakeForPreview
            ? wakeDisabled
              ? undefined
              : () => setShowWakeDialog(true)
            : !hasPreviewUrl
              ? openPreviewSetupView
              : undefined
        }
        icon={AppWindow}
        linkProps={
          disabled || canWakeForPreview || !hasPreviewUrl
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
              disabled={
                restoreSnapshot.isPending || Boolean(taskLaunchDisabledReason)
              }
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
