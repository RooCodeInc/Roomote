'use client';

import type { ReactNode } from 'react';
import { useRouter } from 'next/navigation';

import { useAuthorizedUser } from '@/hooks/useUser';

import { Alert, AlertCircle, AlertDescription } from '@/components/system';

import {
  getAccessibleSettingsNavigation,
  getSettingsNavigationItem,
  type SettingsPageId,
} from './settings-navigation';
import { PageNavigationShell } from './PageNavigationShell';

type SettingsShellProps = {
  pageId: SettingsPageId;
  standalone?: boolean;
  titleOverride?: string;
  descriptionOverride?: string;
  adminOnly?: boolean;
  headerAction?: ReactNode;
  showHeaderActionOnMobile?: boolean;
  boundedContentOnDesktop?: boolean;
  children: ReactNode;
};

export function SettingsShell({
  pageId,
  standalone = false,
  titleOverride,
  descriptionOverride,
  adminOnly = false,
  headerAction,
  showHeaderActionOnMobile,
  boundedContentOnDesktop,
  children,
}: SettingsShellProps) {
  const router = useRouter();
  const { isAdmin, cloudEnabled, brainConfigured } = useAuthorizedUser();

  const navigationItem = getSettingsNavigationItem(pageId);
  const accessibleItems = getAccessibleSettingsNavigation({
    isAdmin,
    cloudEnabled,
    brainConfigured,
  });
  const activeItemId =
    (accessibleItems.some((item) => item.id === pageId)
      ? pageId
      : accessibleItems[0]?.id) ?? 'personal';

  if (!navigationItem && !standalone) {
    throw new Error(`Unknown settings page: ${pageId}`);
  }

  return (
    <PageNavigationShell
      items={accessibleItems}
      activeItemId={activeItemId}
      hideNavigation={standalone}
      title={titleOverride ?? navigationItem?.title ?? ''}
      description={descriptionOverride ?? navigationItem?.description}
      mobileLabel="Settings page"
      headerAction={headerAction}
      showHeaderActionOnMobile={showHeaderActionOnMobile}
      boundedContentOnDesktop={boundedContentOnDesktop}
      onItemSelect={(value) => {
        const nextItem = accessibleItems.find((item) => item.id === value);
        if (nextItem) {
          router.push(nextItem.href);
        }
      }}
    >
      {adminOnly && !isAdmin ? (
        <Alert>
          <AlertCircle className="size-4" />
          <AlertDescription>
            Only admins can access this settings page.
          </AlertDescription>
        </Alert>
      ) : (
        children
      )}
    </PageNavigationShell>
  );
}
