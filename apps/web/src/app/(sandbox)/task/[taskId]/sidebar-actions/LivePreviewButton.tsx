'use client';

import { memo, useRef, useState, type MouseEventHandler } from 'react';

import {
  DEFAULT_MANAGED_DEPLOYMENT_ACCESS,
  EXPIRED_SNAPSHOT_RESUME_ERROR,
  isSnapshotResumable,
} from '@roomote/types';

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
  Spinner,
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
  const [wakeError, setWakeError] = useState<string | null>(null);
  const [wakeRequestedRunId, setWakeRequestedRunId] = useState<number | null>(
    null,
  );
  const wakeRequestedRunIdRef = useRef<number | null>(null);
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
    onSuccess: () => {
      setWakeError(null);
      setShowWakeDialog(false);
    },
    onError: (error) => {
      wakeRequestedRunIdRef.current = null;
      setWakeRequestedRunId(null);
      setWakeError(
        error instanceof Error
          ? error.message
          : 'Live Preview could not be restored. Try again.',
      );
    },
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
  const snapshotExpired =
    Boolean(taskRun.snapshotId) &&
    !isSnapshotResumable(taskRun.snapshotCreatedAt, taskRun.vendor);
  const goingToSleep = asleep && !taskRun.snapshotId;
  const canWakeForPreview =
    asleep && !snapshotExpired && !!taskRun.snapshotId && !!resolvedPreviewUrl;
  const wakeTransitionPending = wakeRequestedRunId === taskRun.id;
  const taskLaunchDisabledReason = getTaskLaunchDisabledReason(managedAccess);
  const wakeDisabled = canWakeForPreview && Boolean(taskLaunchDisabledReason);
  const openUrl =
    resolvedPreviewUrl && taskRun
      ? buildPreviewIframeUrl(resolvedPreviewUrl, taskRun.id)
      : null;
  const hasPreviewUrl = Boolean(resolvedPreviewUrl);
  const disabled =
    disabledUntilReady ||
    !taskRun ||
    wakeDisabled ||
    wakeTransitionPending ||
    snapshotExpired ||
    goingToSleep;
  const tooltip = disabledUntilReady
    ? undefined
    : wakeTransitionPending
      ? 'Waking up Roomote'
      : snapshotExpired
        ? EXPIRED_SNAPSHOT_RESUME_ERROR
        : goingToSleep
          ? 'Live Preview will be available after the task finishes going to sleep'
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
      wakeRequestedRunIdRef.current === taskRun.id ||
      taskLaunchDisabledReason
    ) {
      return;
    }

    setWakeError(null);
    wakeRequestedRunIdRef.current = taskRun.id;
    setWakeRequestedRunId(taskRun.id);

    try {
      await restoreSnapshot.mutateAsync({
        sourceSnapshotId: taskRun.snapshotId,
        sourceRunId: taskRun.id,
        resumePrompt: '',
      });
    } catch {
      // The mutation hook already surfaces the error to the user.
      wakeRequestedRunIdRef.current = null;
      setWakeRequestedRunId(null);
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
          wakeTransitionPending
            ? 'Live Preview is waking up'
            : snapshotExpired
              ? EXPIRED_SNAPSHOT_RESUME_ERROR
              : goingToSleep
                ? 'This task is going to sleep'
                : wakeDisabled
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
      <Dialog
        open={showWakeDialog}
        onOpenChange={(open) => {
          setShowWakeDialog(open);
          if (!open) {
            setWakeError(null);
          }
        }}
      >
        <DialogContent size="sm">
          <DialogHeader>
            <DialogTitle>Wake up Roomote?</DialogTitle>
            <DialogDescription>
              Live Preview needs the task to be awake. Waking it up will restore
              the task and make preview available again.
            </DialogDescription>
          </DialogHeader>
          {wakeError ? (
            <p role="alert" className="text-sm text-destructive">
              {wakeError}
            </p>
          ) : null}
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
                restoreSnapshot.isPending ||
                wakeTransitionPending ||
                Boolean(taskLaunchDisabledReason)
              }
              aria-busy={restoreSnapshot.isPending}
            >
              {restoreSnapshot.isPending ? <Spinner /> : null}
              {restoreSnapshot.isPending ? 'Waking up...' : 'Wake up'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

export const LivePreviewButton = memo(LivePreviewButtonBase);
