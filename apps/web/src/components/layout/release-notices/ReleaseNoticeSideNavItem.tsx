'use client';

import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';

import { Astroid, Sparkles } from '@/components/system';
import { isProductVersionNewer, toReleaseTag } from '@/lib/product-version';
import { useTRPC } from '@/trpc/client';

import { SideNavItem } from '../side-nav/SideNavItem';
import { ReleaseNotesDialog } from './ReleaseNotesDialog';
import {
  readWhatsNewSeenVersion,
  writeWhatsNewSeenVersion,
} from './whats-new-storage';

type NoticeKind = 'whats-new' | 'update-available';

type ActiveDialog = {
  mode: NoticeKind;
  version: string;
};

export function ReleaseNoticeSideNavItem({
  expanded = false,
}: {
  expanded?: boolean;
}) {
  const trpc = useTRPC();
  const [hasHydratedStorage, setHasHydratedStorage] = useState(false);
  const [seenVersion, setSeenVersion] = useState<string | null>(null);
  const [activeDialog, setActiveDialog] = useState<ActiveDialog | null>(null);

  const statusQuery = useQuery(
    trpc.releases.status.queryOptions(undefined, {
      staleTime: 30 * 60 * 1000,
      refetchOnWindowFocus: false,
    }),
  );

  useEffect(() => {
    setSeenVersion(readWhatsNewSeenVersion());
    setHasHydratedStorage(true);
  }, []);

  const runningVersion = statusQuery.data?.runningVersion ?? null;
  const latestKnownVersion = statusQuery.data?.latestKnownVersion ?? null;
  const updateAvailable = statusQuery.data?.updateAvailable ?? false;

  useEffect(() => {
    if (!hasHydratedStorage || !runningVersion) {
      return;
    }

    if (seenVersion === null) {
      writeWhatsNewSeenVersion(runningVersion);
      setSeenVersion(runningVersion);
    }
  }, [hasHydratedStorage, runningVersion, seenVersion]);

  const noticeKind = useMemo<NoticeKind | null>(() => {
    if (!hasHydratedStorage || !runningVersion) {
      return null;
    }

    if (
      seenVersion !== null &&
      isProductVersionNewer(runningVersion, seenVersion)
    ) {
      return 'whats-new';
    }

    if (updateAvailable && latestKnownVersion) {
      return 'update-available';
    }

    return null;
  }, [
    hasHydratedStorage,
    latestKnownVersion,
    runningVersion,
    seenVersion,
    updateAvailable,
  ]);

  const iconVersion =
    noticeKind === 'update-available'
      ? (latestKnownVersion ?? runningVersion)
      : runningVersion;

  if (!noticeKind || !iconVersion) {
    return null;
  }

  const openDialog = () => {
    const version =
      noticeKind === 'update-available'
        ? (latestKnownVersion ?? runningVersion)
        : runningVersion;
    if (!version) {
      return;
    }

    setActiveDialog({ mode: noticeKind, version });
    if (noticeKind === 'whats-new' && runningVersion) {
      writeWhatsNewSeenVersion(runningVersion);
      setSeenVersion(runningVersion);
    }
  };

  return (
    <>
      <SideNavItem
        icon={noticeKind === 'whats-new' ? Sparkles : Astroid}
        label={noticeKind === 'whats-new' ? "What's new" : 'Update available'}
        tooltip={
          noticeKind === 'whats-new'
            ? `What's new in Roomote ${toReleaseTag(runningVersion ?? iconVersion)}`
            : `Roomote ${toReleaseTag(iconVersion)} is available`
        }
        description={
          noticeKind === 'whats-new'
            ? 'See what changed in this release'
            : 'A newer Roomote release is ready'
        }
        expanded={expanded}
        active={false}
        highlight
        onClick={openDialog}
      />
      {activeDialog ? (
        <ReleaseNotesDialog
          open
          onOpenChange={(open) => {
            if (!open) {
              setActiveDialog(null);
            }
          }}
          mode={activeDialog.mode}
          version={activeDialog.version}
          runningVersion={runningVersion}
        />
      ) : null}
    </>
  );
}
