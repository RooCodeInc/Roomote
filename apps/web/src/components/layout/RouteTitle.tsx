'use client';

import { usePathname } from 'next/navigation';

import { usePageTitle } from '@/hooks/usePageTitle';
import { getSettingsTitleForPath } from '@/components/settings/settings-navigation';

const ROUTE_TITLES: [RegExp, string][] = [
  [/^\/analytics$/, 'Analytics'],
  [/^\/sessions$/, 'Sessions'],
  [/^\/$/, 'Home'],
];

function getTitleForPath(pathname: string): string | null {
  const settingsTitle = getSettingsTitleForPath(pathname);

  if (settingsTitle) {
    return settingsTitle;
  }

  for (const [pattern, title] of ROUTE_TITLES) {
    if (pattern.test(pathname)) {
      return title;
    }
  }

  return null;
}

export function RouteTitle() {
  const pathname = usePathname();
  usePageTitle(getTitleForPath(pathname));
  return null;
}
