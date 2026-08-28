'use client';

import { type ReactNode } from 'react';

import { type AnalyticsObject } from '@/types';
import {
  ChartColumnIncreasing,
  CircleDollarSign,
  Download,
  Button,
  Spinner,
} from '@/components/system';
import { PageNavigationShell } from '@/components/settings/PageNavigationShell';

export type AnalyticsShellItemId = Exclude<AnalyticsObject, 'sessions'>;

export function getAnalyticsHref(itemId: AnalyticsShellItemId) {
  switch (itemId) {
    case 'tasks':
      return '/analytics?object=tasks';
    case 'pullRequests':
      return '/analytics?object=pullRequests';
    case 'costs':
      return '/analytics';
  }
}

const ANALYTICS_SHELL_ITEMS = [
  { id: 'costs', label: 'Costs', icon: CircleDollarSign },
  { id: 'tasks', label: 'Tasks', icon: ChartColumnIncreasing },
] as const satisfies Array<{
  id: AnalyticsObject;
  label: string;
  icon: typeof ChartColumnIncreasing;
}>;

const ANALYTICS_DESCRIPTIONS: Record<AnalyticsShellItemId, string> = {
  pullRequests:
    'Track pull request activity by user, status, repository, and author.',
  tasks: 'Track task activity by user, environment, source, and task type.',
  costs: 'Understand your inference spend',
};

type AnalyticsShellProps = {
  activeItemId: AnalyticsShellItemId;
  title: string;
  headerAction?: ReactNode;
  onItemSelect: (value: AnalyticsShellItemId) => void;
  children: ReactNode;
};

export function AnalyticsShell({
  activeItemId,
  title,
  headerAction,
  onItemSelect,
  children,
}: AnalyticsShellProps) {
  const items = ANALYTICS_SHELL_ITEMS;
  const resolvedActiveItemId =
    (items.some((item) => item.id === activeItemId)
      ? activeItemId
      : items[0]?.id) ?? 'costs';

  return (
    <PageNavigationShell
      items={items}
      activeItemId={resolvedActiveItemId}
      title={title}
      description={ANALYTICS_DESCRIPTIONS[activeItemId]}
      mobileLabel="Analytics view"
      headerAction={headerAction}
      showHeaderActionOnMobile
      onItemSelect={(value) => onItemSelect(value as AnalyticsShellItemId)}
    >
      {children}
    </PageNavigationShell>
  );
}

type AnalyticsShellDownloadActionProps = {
  isDisabled: boolean;
  isExporting: boolean;
  onDownload: () => void;
};

export function AnalyticsShellDownloadAction({
  isDisabled,
  isExporting,
  onDownload,
}: AnalyticsShellDownloadActionProps) {
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      disabled={isDisabled}
      aria-label={isExporting ? 'Preparing download' : 'Download data'}
      aria-busy={isExporting}
      onClick={onDownload}
      className="gap-2 disabled:cursor-default disabled:border-border/40 disabled:text-muted-foreground disabled:opacity-45 disabled:hover:border-border/40 disabled:hover:text-muted-foreground"
    >
      {isExporting ? (
        <>
          <Spinner />
          <span className="hidden md:inline">Preparing...</span>
        </>
      ) : (
        <>
          <Download />
          <span className="hidden md:inline">Download data</span>
        </>
      )}
    </Button>
  );
}
