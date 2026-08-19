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
  adminOnly?: boolean;
  headerAction?: ReactNode;
  children: ReactNode;
};

export function SettingsShell({
  pageId,
  adminOnly = false,
  headerAction,
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

  if (!navigationItem) {
    throw new Error(`Unknown settings page: ${pageId}`);
  }

  return (
    <PageNavigationShell
      items={accessibleItems}
      activeItemId={activeItemId}
      title={navigationItem.title}
      description={navigationItem.description}
      mobileLabel="Settings page"
      headerAction={headerAction}
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
