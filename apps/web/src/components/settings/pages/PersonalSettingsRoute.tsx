'use client';

import { useQuery } from '@tanstack/react-query';

import { useAuthorizedUser } from '@/hooks/useUser';
import { useTRPC } from '@/trpc/client';

import { PersonalSettingsPage } from './PersonalSettingsPage';

export function PersonalSettingsRoute() {
  const user = useAuthorizedUser();
  const trpc = useTRPC();
  const accountCapabilities = useQuery(
    trpc.preferences.accountCapabilities.queryOptions(),
  );

  return (
    <PersonalSettingsPage
      canChangePassword={accountCapabilities.data?.canChangePassword ?? false}
      canSetPassword={accountCapabilities.data?.canSetPassword ?? false}
      profile={{
        email: user.primaryEmail ?? '',
        imageUrl: user.resource.imageUrl,
        name: user.name ?? user.primaryEmail ?? 'User',
      }}
    />
  );
}
